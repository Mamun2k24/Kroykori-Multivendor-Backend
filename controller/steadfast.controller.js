// Place this file at: backend/controller/steadfast.controller.js
// Requires Node.js 18+ (built-in fetch).
import mongoose from "mongoose";
import { Order } from "../model/index.model.js";

const COURIER_URL = "https://portal.packzy.com/api/v1/create_order";

const normalizeBdPhone = (input) => {
  const digits = String(input || "").replace(/\D/g, "");
  return digits.length === 13 && digits.startsWith("880")
    ? digits.slice(2)
    : digits;
};

export const sendOrderToSteadfast = async (req, res) => {
  const { orderId } = req.params;
  if (!mongoose.isValidObjectId(orderId)) {
    return res.status(400).json({ message: "Invalid order ID" });
  }

  if (!process.env.STEADFAST_API_KEY || !process.env.STEADFAST_SECRET_KEY) {
    return res.status(503).json({ message: "Steadfast API is not configured" });
  }

  let locked = false;
  try {
    const order = await Order.findById(orderId).lean();
    if (!order) return res.status(404).json({ message: "Order not found" });

    if (order.orderStatus !== "processing") {
      return res.status(409).json({ message: "Only processing orders can be sent to Steadfast" });
    }

    // One merchant parcel per order. Seller/multi-vendor fulfillment needs
    // a separate consignment per seller/sub-order and dedicated pickup rules.
    if (order.sellerOrders?.length !== 1 || order.sellerOrders[0].source !== "platform"
        || order.sellerOrders[0].orderStatus !== "processing") {
      return res.status(422).json({
        message: "This integration currently supports only single-platform orders. Seller/multi-vendor orders need separate consignments.",
      });
    }

    const recipientPhone = normalizeBdPhone(order.customer?.mobile);
    const recipientName = String(order.customer?.name || "").trim();
    const recipientAddress = String(order.address || "").trim();

    if (!/^01[3-9]\d{8}$/.test(recipientPhone)) {
      return res.status(422).json({ message: "Customer mobile must be a valid 11-digit BD number" });
    }
    if (!recipientName || recipientName.length > 100) {
      return res.status(422).json({ message: "Customer name must be 1–100 characters" });
    }
    if (recipientAddress.length < 10 || recipientAddress.length > 250) {
      return res.status(422).json({ message: "Enter a complete delivery address (10–250 characters)" });
    }

    const paymentMethod = String(
      order.paymentMethod || ""
    ).trim().toLowerCase();

    const paymentStatus = String(
      order.paymentStatus || "unpaid"
    ).trim().toLowerCase();

    console.log("Steadfast Payment Check:", {
      paymentMethod,
      paymentStatus,
    });

    const isCOD = [
      "cash on delivery",
      "cash",
      "cod",
    ].includes(paymentMethod);

    const isPrepaid = [
      "bkash",
      "nagad",
    ].includes(paymentMethod);

    // Unknown payment method
    if (!isCOD && !isPrepaid) {
      return res.status(422).json({
        message: "Unsupported payment method",
      });
    }

    // Prepaid payment must be verified
    if (isPrepaid && paymentStatus !== "paid") {
      return res.status(409).json({
        message: "Verify prepaid payment first",
      });
    }

    // Customer pays courier on delivery
    const codAmount =
      isCOD && paymentStatus !== "paid"
        ? Number(order.totalPrice || 0)
        : 0;

    if (!Number.isFinite(codAmount) || codAmount < 0) {
      return res.status(422).json({ message: "Invalid COD amount" });
    }

    const invoiceCode = `KK-${order._id}`; // Stable, unique on Steadfast

    // Atomic claim: stops concurrent clicks and blocks duplicates.
    const claimed = await Order.findOneAndUpdate(
      {
        _id: order._id,
        orderStatus: "processing",
        "steadfast.status": { $in: [null, "not_sent"] },
      },
      {
        $set: {
          "steadfast.status": "creating",
          "steadfast.invoice": invoiceCode,
          "steadfast.codAmount": codAmount,
        },
      },
      { new: true },
    );

    if (!claimed) {
      return res.status(409).json({
        message: "This order is already sent, being sent, or needs reconciliation. Check Steadfast status before trying again.",
      });
    }
    locked = true;

    const payload = {
      invoice: invoiceCode,
      recipient_name: recipientName,
      recipient_phone: recipientPhone,
      recipient_address: recipientAddress,
      cod_amount: codAmount,
      delivery_type: 0,
      item_description: (order.products || [])
        .map((item) => `${item.productName} x${item.quantity}${item.selectedSize ? ` (${item.selectedSize})` : ""}`)
        .join(", ")
        .slice(0, 200),
    };

    const response = await fetch(COURIER_URL, {
      method: "POST",
      headers: {
        "Api-Key": process.env.STEADFAST_API_KEY,
        "Secret-Key": process.env.STEADFAST_SECRET_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    });

    const result = await response.json().catch(() => ({}));
    const consignment = result?.consignment;
    if (!response.ok || Number(result?.status) !== 200 ||
        !consignment?.consignment_id || !consignment?.tracking_code) {
      throw new Error("Steadfast did not confirm consignment creation");
    }

    const updatedOrder = await Order.findOneAndUpdate(
      { _id: order._id, "steadfast.status": "creating", "steadfast.invoice": invoiceCode },
      {
        $set: {
          "steadfast.status": "created",
          "steadfast.consignmentId": Number(consignment.consignment_id),
          "steadfast.trackingCode": String(consignment.tracking_code),
          "steadfast.sentAt": new Date(),
          "sellerOrders.0.courierName": "Steadfast",
          "sellerOrders.0.trackingCode": String(consignment.tracking_code),
        },
      },
      { new: true },
    );

    if (!updatedOrder) throw new Error("Courier created, but local save needs reconciliation");

    return res.status(201).json({
      message: "Steadfast consignment created successfully (not yet shipped)",
      order: updatedOrder,
      trackingCode: String(consignment.tracking_code),
      consignmentId: Number(consignment.consignment_id),
    });
  } catch (error) {
    // A timeout or DB write error might happen AFTER the courier created it.
    // Do NOT allow automatic retry; reconcile by invoice in the courier portal.
    if (locked) {
      await Order.updateOne(
        { _id: orderId, "steadfast.status": "creating" },
        { $set: { "steadfast.status": "needs_review" } },
      ).catch(() => {});
    }
    console.error("Steadfast submission error:", error.message);
    return res.status(502).json({
      message: "Steadfast submission could not be confirmed. Check the courier portal using the order invoice before any retry.",
    });
  }
};