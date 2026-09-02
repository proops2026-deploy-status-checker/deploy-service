import express from "express";

const app = express();
const port = process.env.PORT ?? 3001;

// Walking skeleton: health check only, no deploy API yet (TIE-11, TIE-12)
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(port, () => {
  console.log(`deploy-service listening on port ${port}`);
});
