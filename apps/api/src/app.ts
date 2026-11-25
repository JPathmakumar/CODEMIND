import repositoriesRouter from "./routes/repositories.js";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import filesRouter from "./routes/files.js";
import analysisRouter from "./routes/analysis.js";

export const app = express();

app.use(helmet());

app.use(
  cors({
    origin: "http://localhost:5173"
  })
);

app.use(express.json({ limit: "1mb" }));
app.use("/api/repositories", repositoriesRouter);
app.use("/api/files", filesRouter);
app.use("/api/analysis", analysisRouter);

app.get("/api/health", (_req, res) => {
  res.json({
    success: true,
    application: "CODEMIND",
    status: "operational"
  });
});
