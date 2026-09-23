CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE "messages" ADD COLUMN "embedding" vector(384);
CREATE INDEX "messages_embedding_hnsw_idx" ON "messages" USING hnsw ("embedding" vector_cosine_ops);
