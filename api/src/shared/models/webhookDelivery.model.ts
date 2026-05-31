import mongoose, { Schema, model, type HydratedDocument, type Model } from 'mongoose';

// One row per GitHub webhook delivery (keyed by X-GitHub-Delivery). It is a
// success-marker, not a seen-marker: `processedOk` flips to true only when the
// handler fully succeeds, so a redelivery of a row that never finished is
// re-attempted rather than silently dropped.
export interface WebhookDelivery {
  deliveryId: string; // X-GitHub-Delivery
  event: string; // X-GitHub-Event
  webhookId: number; // X-GitHub-Hook-ID, kept for forensics
  receivedAt: Date; // TTL-expired after 30 days
  processedOk: boolean;
  lastError?: string;
  attempts: number;
}

const webhookDeliverySchema = new Schema<WebhookDelivery>({
  deliveryId: { type: String, required: true, unique: true },
  event: { type: String, required: true },
  webhookId: { type: Number, required: true, index: true },
  receivedAt: { type: Date, required: true },
  processedOk: { type: Boolean, required: true, default: false },
  lastError: { type: String },
  attempts: { type: Number, required: true, default: 0 },
});

// Deliveries are only needed for the short dedupe window; expire after 30 days.
webhookDeliverySchema.index({ receivedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export type WebhookDeliveryDocument = HydratedDocument<WebhookDelivery>;
export const WebhookDeliveryModel: Model<WebhookDelivery> =
  (mongoose.models.WebhookDelivery as Model<WebhookDelivery> | undefined) ??
  model<WebhookDelivery>('WebhookDelivery', webhookDeliverySchema);
