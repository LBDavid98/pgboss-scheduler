/**
 * Prometheus metrics.
 *
 * Scraped BY CONTAINER NAME (`pgboss-scheduler:8020`) the way node-exporter and
 * cadvisor are, not by a blackbox probe on 127.0.0.1: blackbox-exporter runs
 * `network_mode: host` on your fleet, and this service publishes no port. That is
 * why the container joins the monitoring network.
 *
 * Labels are queue names and outcomes only. A label whose value comes from job
 * data would let one caller blow up the cardinality of everyone's metrics.
 */

import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();
registry.setDefaultLabels({ service: "pgboss-scheduler" });
collectDefaultMetrics({ register: registry });

export const deliveries = new Counter({
  name: "scheduler_deliveries_total",
  help: "Push deliveries attempted, by queue and outcome.",
  labelNames: ["queue", "outcome"] as const,
  registers: [registry],
});

export const deliveryDuration = new Histogram({
  name: "scheduler_delivery_duration_seconds",
  help: "How long a push delivery took, by queue.",
  labelNames: ["queue"] as const,
  // Tuned for both kinds of target: a webhook answers in milliseconds, an agent
  // run takes minutes, and one bucket set has to make both legible.
  buckets: [0.05, 0.25, 1, 5, 15, 60, 180, 600],
  registers: [registry],
});

export const enqueued = new Counter({
  name: "scheduler_jobs_enqueued_total",
  help: "Jobs enqueued, by queue and the caller that enqueued them.",
  labelNames: ["queue", "caller"] as const,
  registers: [registry],
});

export const deadLettered = new Counter({
  name: "scheduler_jobs_dead_lettered_total",
  help: "Jobs that exhausted their retries and were dead-lettered, by queue.",
  labelNames: ["queue"] as const,
  registers: [registry],
});
