/** Configurable URLs for the external split + Fastify pipeline.
 *  Override via environment variables or .env.local. */

export const SPLITTER_URL = process.env.SPLITTER_URL || "http://localhost:8000";
export const FASTIFY_URL = process.env.FASTIFY_URL || "http://localhost:4000";
export const SHARED_PROCESS_DIR = process.env.SHARED_PROCESS_DIR || "/tmp/output-json";
