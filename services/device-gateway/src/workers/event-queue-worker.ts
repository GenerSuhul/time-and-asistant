import { processGatewayEvent } from "../services/event-ingestion.js";
import { logger } from "../logger.js";
import { supabase } from "../supabase.js";

let running = false;

export async function runEventQueueOnce() {
  if (running) return;
  running = true;
  try {
    const { data: queueItems, error } = await supabase
      .from("event_ingestion_queue")
      .select("*")
      .eq("status", "pending")
      .lte("next_retry_at", new Date().toISOString())
      .order("created_at", { ascending: true })
      .limit(25);

    if (error) throw error;

    for (const item of queueItems ?? []) {
      await supabase.from("event_ingestion_queue").update({ status: "processing" }).eq("id", item.id);
      try {
        await processGatewayEvent(item.payload, { source: "queue", skipQueue: true, queueId: item.id });
      } catch (error) {
        const retryCount = (item.retry_count ?? 0) + 1;
        const shouldRetry = retryCount < 5;
        const nextRetry = new Date(Date.now() + Math.min(30, 2 ** retryCount) * 1000).toISOString();
        await supabase
          .from("event_ingestion_queue")
          .update({
            status: shouldRetry ? "pending" : "failed",
            retry_count: retryCount,
            next_retry_at: nextRetry,
            error_message: error instanceof Error ? error.message : String(error)
          })
          .eq("id", item.id);
      }
    }
  } finally {
    running = false;
  }
}

export function startEventQueueWorker() {
  void runEventQueueOnce().catch((error) => logger.error({ err: error }, "Event queue worker failed"));
  setInterval(() => {
    void runEventQueueOnce().catch((error) => logger.error({ err: error }, "Event queue worker failed"));
  }, 5000);
}
