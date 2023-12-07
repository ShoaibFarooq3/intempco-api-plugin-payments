import ReactionError from "@reactioncommerce/reaction-error";
import SimpleSchema from "simpl-schema";

const inputSchema = new SimpleSchema({
  orderId: String,
  paymentIds: [String],
  shopId: String
});

/**
 * @method captureOrderPayments
 * @summary Attempt to capture one or more authorized payments for an order
 * @param {Object} context -  an object containing the per-request state
 * @param {Object} input - CaptureOrderPaymentsInput
 * @param {String} input.orderId - The order ID
 * @param {String[]} input.paymentIds - An array of one or more payment IDs to capture
 * @param {String} input.shopId - The ID of the shop that owns this order
 * @returns {Promise<Object>} CaptureOrderPaymentsResult
 */
export default async function captureOrderPayments(context, input = {}) {
  inputSchema.validate(input);
  const { appEvents, collections, userId } = context;
  const { Orders } = collections;
  const { orderId, paymentIds, shopId } = input;
  console.log("In capture Order Payments without token")
  //await context.validatePermissions(`reaction:legacy:orders:${orderId}`, "capture:payment", { shopId });

  const order = await Orders.findOne({ _id: orderId, shopId });
  if (!order) throw new ReactionError("not-found", "Order not found");

  // If order status is still "new", bump to "processing"
  if (order.workflow.status === "new") {
    await Orders.updateOne({ _id: orderId }, {
      $set: {
        "workflow.status": "coreOrderWorkflow/processing"
      },
      $addToSet: {
        "workflow.workflow": "coreOrderWorkflow/processing"
      }
    });
  }
  console.log("Payment Ids are ",paymentIds)
  console.log("After order workflow ",order)

  // const orderPaymentsToCapture = (order.payments || []).filter((payment) =>
  //   paymentIds.includes(payment._id) && payment.mode === "authorize" && ["approved", "error"].includes(payment.status));
  const orderPaymentsToCapture = (order.payments || []).filter((payment) => {
  
    console.log("Payment id ",payment._id,payment.mode,payment.status)
    const isPaymentToCapture = paymentIds.includes(payment._id) &&
      payment.mode === "authorize" &&
      ["created","approved", "error"].includes(payment.status);
  
    if (isPaymentToCapture) {
      console.log(`Payment ID: ${payment._id}, Status: ${payment.status}, Mode: ${payment.mode}`);
    }
  
    return isPaymentToCapture;
  });

  console.log("Order Payment To Capture Check ",orderPaymentsToCapture)

  if (orderPaymentsToCapture.length === 0) return { order };

  console.log("Order payments to capture ",orderPaymentsToCapture)

  // TODO capture a specific amount, maybe partial, if only some groups are fulfilled

  const capturePromises = orderPaymentsToCapture.map(async (payment) => {
    let result = { saved: false };
    try {
      result = await context.queries.getPaymentMethodConfigByName(payment.name).functions.capturePayment(context, payment);
    } catch (error) {
      result.error = error;
      result.errorCode = "uncaught_plugin_error";
      result.errorMessage = error.message;
    }
    result.paymentId = payment._id;
    return result;
  });

  const captureResults = await Promise.all(capturePromises);

  console.log("Capture results are ",captureResults)

  const updatedPayments = order.payments;
  const capturedPayments = [];
  captureResults.forEach((captureResult) => {
    const payment = updatedPayments.find((pmt) => pmt._id === captureResult.paymentId);

    if (captureResult.saved || captureResult.isAlreadyCaptured) {
      payment.mode = "captured";
      payment.status = "completed";
      payment.metadata = { ...(payment.metadata || {}), ...(captureResult.metadata || {}) };
      capturedPayments.push(payment);
    } else {
      payment.status = "error";
      payment.captureErrorCode = captureResult.errorCode;
      payment.captureErrorMessage = captureResult.errorMessage;
    }

    payment.transactions.push(captureResult);
  });

  const { value: updatedOrder } = await Orders.findOneAndUpdate({ _id: orderId }, {
    $set: {
      payments: updatedPayments,
      updatedAt: new Date()
    }
  }, { returnOriginal: false });

  await appEvents.emit("afterOrderUpdate", {
    order: updatedOrder,
    updatedBy: userId
  });

  capturedPayments.forEach((payment) => {
    appEvents.emit("afterOrderPaymentCapture", {
      capturedBy: userId,
      order: updatedOrder,
      payment
    });
  });

  return { order: updatedOrder };
}
