import { defineConfig } from "wxt";

/** Origins the user can grant at runtime; nothing is granted at install. */
const OPTIONAL_ORIGINS = ["https://*/*", "http://*/*"];

export default defineConfig({
  manifest: ({ browser, manifestVersion }) => ({
    name: "MathPad — draw LaTeX anywhere",
    description: "Draw math on your phone, get it at your cursor wherever you trust MathPad.",
    permissions: ["storage", "scripting", "activeTab"],
    // The API server is the only host MathPad can reach without user consent.
    host_permissions: ["http://localhost:8080/*"],
    // MV3 has a dedicated key; MV2 expects host patterns in optional_permissions.
    ...(manifestVersion === 2
      ? { optional_permissions: OPTIONAL_ORIGINS }
      : { optional_host_permissions: OPTIONAL_ORIGINS }),
    // MathPad processes content locally and stores trust/pairing data on-device.
    ...(browser === "firefox"
      ? {
          browser_specific_settings: {
            gecko: {
              data_collection_permissions: { required: ["none"] },
            },
          },
        }
      : {}),
  }),
  // TODO: point at the prod server URL once deployed
});
