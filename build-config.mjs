// build-config.mjs — runs at Netlify build time.
// Writes the PUBLIC front-end config from environment variables so the browser
// reads them via window.__CONFIG instead of hardcoded values.
// Only public values go here (URL + anon key + room code). The service_role key
// is never written to the front end.
import { writeFileSync } from "node:fs";

const cfg = {
  SUPABASE_URL: process.env.SUPABASE_URL || "",
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || "",
  ROOM_CODE: process.env.ROOM_CODE || "WC26",
  FUNCTIONS_BASE: "/.netlify/functions",
};

writeFileSync("config.js", `window.__CONFIG=${JSON.stringify(cfg)};`);
console.log("wrote config.js:", {
  ...cfg,
  SUPABASE_ANON_KEY: cfg.SUPABASE_ANON_KEY ? "(set)" : "(MISSING)",
  SUPABASE_URL: cfg.SUPABASE_URL || "(MISSING)",
});
