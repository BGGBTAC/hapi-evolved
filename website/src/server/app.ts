import express from "express";
import path from "path";

export function createApp(staticPath: string) {
  const app = express();

  app.use(express.static(staticPath));

  // Handle client-side routing - serve index.html for all routes
  app.get("/{*splat}", (_req, res) => {
    res.sendFile(path.join(staticPath, "index.html"));
  });

  return app;
}
