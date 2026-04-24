import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

type ExportSessionToHtml = (
  sessionManager: any,
  state?: {
    systemPrompt?: string;
    tools?: Array<{ name: string; description?: string; parameters?: unknown }>;
  },
  options?: string | { outputPath?: string },
) => Promise<string>;

function getShareViewerUrl(gistId: string): string {
  const base = process.env.PI_SHARE_VIEWER_URL || "https://pi.dev/session/";
  const normalizedBase = base.includes("#") ? base.replace(/#.*$/, "#") : `${base}#`;
  return `${normalizedBase}${gistId}`;
}

export default function (pi: ExtensionAPI) {
  // Lazily resolved on first use.
  let _exportSessionToHtml: ExportSessionToHtml | undefined;

  async function getExportFn(): Promise<ExportSessionToHtml> {
    if (_exportSessionToHtml) return _exportSessionToHtml;

    // Resolve the pi package root from its public entry, then navigate to the
    // internal export-html module. This is not part of the public API and may
    // break across releases — but it is the only way to access the HTML export.
    //
    // Use import.meta.resolve() (ESM) instead of createRequire().resolve() (CJS)
    // because the pi package's "exports" map only defines an "import" condition.
    const piEntryUrl = import.meta.resolve("@mariozechner/pi-coding-agent");
    const piEntry = new URL(piEntryUrl).pathname;
    const exportModulePath = path.join(path.dirname(piEntry), "core", "export-html", "index.js");
    const mod = (await import(pathToFileURL(exportModulePath).href)) as {
      exportSessionToHtml: ExportSessionToHtml;
    };
    _exportSessionToHtml = mod.exportSessionToHtml;
    return _exportSessionToHtml;
  }

  pi.registerCommand("share-as", {
    description: "Create a private GitHub gist using a custom name: /share-as <name>",
    handler: async (args, ctx) => {
      const requestedName = args.trim() || pi.getSessionName()?.trim() || "";
      if (!requestedName) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /share-as <name>", "warning");
        return;
      }

      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "Cannot share an in-memory session. Save or start a normal session first.",
            "error",
          );
        return;
      }

      // Verify gh is installed and authenticated.
      try {
        const authResult = await pi.exec("gh", ["auth", "status"]);
        if (authResult.code !== 0) {
          if (ctx.hasUI)
            ctx.ui.notify("GitHub CLI is not logged in. Run 'gh auth login' first.", "error");
          return;
        }
      } catch {
        if (ctx.hasUI)
          ctx.ui.notify(
            "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/",
            "error",
          );
        return;
      }

      await ctx.waitForIdle();

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-share-as-"));
      const tmpFile = path.join(tmpDir, "session.html");

      try {
        const allTools = new Map(pi.getAllTools().map((tool) => [tool.name, tool] as const));
        const activeTools = pi
          .getActiveTools()
          .map((name) => allTools.get(name))
          .filter((tool): tool is NonNullable<typeof tool> => Boolean(tool))
          .map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          }));

        let systemPrompt: string | undefined;
        try {
          systemPrompt = ctx.getSystemPrompt();
        } catch {
          systemPrompt = undefined;
        }

        const exportSessionToHtml = await getExportFn();
        await exportSessionToHtml(
          ctx.sessionManager,
          { systemPrompt, tools: activeTools },
          tmpFile,
        );
      } catch (error) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`,
            "error",
          );
        }
        return;
      }

      try {
        const result = await pi.exec("gh", ["gist", "create", "--desc", requestedName, tmpFile], {
          signal: ctx.signal,
        });

        if (result.code !== 0) {
          if (ctx.hasUI)
            ctx.ui.notify(
              `Failed to create gist: ${result.stderr.trim() || "Unknown error"}`,
              "error",
            );
          return;
        }

        const gistUrl = result.stdout
          .trim()
          .split(/\s+/)
          .find((part) => part.startsWith("https://gist.github.com/"));
        const gistId = gistUrl?.split("/").pop();

        // Update the gist description to include the pi.dev/session viewer URL.
        if (gistId) {
          const previewUrl = getShareViewerUrl(gistId);
          const fullDesc = `${requestedName} — ${previewUrl}`;
          await pi.exec(
            "gh",
            ["api", "--method", "PATCH", `/gists/${gistId}`, "-f", `description=${fullDesc}`],
            { signal: ctx.signal },
          );
        }
        if (!gistUrl || !gistId) {
          if (ctx.hasUI) ctx.ui.notify("Failed to parse gist URL from gh output.", "error");
          return;
        }

        const previewUrl = getShareViewerUrl(gistId);
        pi.sendMessage(
          {
            customType: "share-as-result",
            content:
              `Shared session as **${requestedName}**\n\n` +
              `- Share URL: ${previewUrl}\n` +
              `- Gist URL: ${gistUrl}`,
            display: true,
            details: { requestedName, previewUrl, gistUrl, gistId },
          },
          { triggerTurn: false },
        );
      } catch (error) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Failed to create gist: ${error instanceof Error ? error.message : "Unknown error"}`,
            "error",
          );
        }
      } finally {
        try {
          fs.rmSync(tmpDir, { recursive: true });
        } catch {
          // Ignore cleanup errors.
        }
      }
    },
  });
}
