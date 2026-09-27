import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface PiControlServices {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
}
