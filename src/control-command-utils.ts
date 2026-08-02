import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export async function confirmAndWaitForIdle(
  ctx: ExtensionCommandContext,
  title: string,
  message: string,
): Promise<boolean> {
  const confirmed = await ctx.ui.confirm(title, message);
  if (confirmed) {
    await ctx.waitForIdle();
  }
  return confirmed;
}
