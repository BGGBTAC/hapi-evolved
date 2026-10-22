import express from "express";
import { rateLimit } from "express-rate-limit";
import path from "path";

export function createApp(staticPath: string, requestsPerMinute = 1200) {
  const app = express();

  // The static SPA still performs a filesystem lookup on every uncached request.
  // Use the transport peer address: untrusted forwarding headers must not let a
  // caller create arbitrary rate-limit identities.
  app.use(rateLimit({ windowMs: 60_000, limit: requestsPerMinute, standardHeaders: "draft-8", legacyHeaders: false,
    validate: { xForwardedForHeader: false } }));
  app.use(express.static(staticPath));

  // Handle client-side routing - serve index.html for all routes
  app.get("/{*splat}", (_req, res) => {
    res.sendFile(path.join(staticPath, "index.html"));
  });

  return app;
}
