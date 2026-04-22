import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

type ExportSessionToHtml = (
	sessionManager: any,
	state?: { systemPrompt?: string; tools?: Array<{ name: string; description?: string; parameters?: unknown }> },
	options?: string | { outputPath?: string },
) => Promise<string>;

function getShareViewerUrl(gistId: string): string {
	const base = process.env.PI_SHARE_VIEWER_URL || "https://pi.dev/session/";
	const normalizedBase = base.includes("#") ? base.replace(/#.*$/, "#") : `${base}#`;
	return `${normalizedBase}${gistId}`;
}

function getNodeGlobalRoots(): string[] {
	const roots = new Set<string>();
	const execDir = path.dirname(process.execPath);
	roots.add(path.resolve(execDir, "..", "lib", "node_modules"));
	roots.add(path.resolve(execDir, "..", "..", "lib", "node_modules"));

	for (const entry of (process.env.NODE_PATH || "").split(path.delimiter)) {
		if (entry) roots.add(path.resolve(entry));
	}

	try {
		const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf-8" });
		if (npmRoot.status === 0 && npmRoot.stdout.trim()) {
			roots.add(path.resolve(npmRoot.stdout.trim()));
		}
	} catch {
		// Ignore npm lookup failures.
	}

	roots.add("/usr/lib/node_modules");
	roots.add("/usr/local/lib/node_modules");
	return [...roots];
}

function resolvePiPackageEntry(require: NodeRequire): string {
	const cliArg = process.argv[1] || "";
	const packageDirCandidates = [
		process.env.PI_AGENT_PACKAGE_DIR,
		cliArg ? path.resolve(path.dirname(cliArg), "..") : undefined,
		...getNodeGlobalRoots().map((root) => path.join(root, "@mariozechner", "pi-coding-agent")),
	]
		.filter((value): value is string => Boolean(value))
		.map((value) => path.resolve(value));

	for (const root of packageDirCandidates) {
		const packageEntry = path.join(root, "dist", "index.js");
		if (fs.existsSync(packageEntry)) {
			return packageEntry;
		}
	}

	const extensionDir = path.dirname(fileURLToPath(import.meta.url));
	const resolvePaths = [process.cwd(), extensionDir, ...getNodeGlobalRoots()];
	return require.resolve("@mariozechner/pi-coding-agent", {
		paths: resolvePaths,
	});
}

export default async function shareAsExtension(pi: any) {
	const require = createRequire(import.meta.url);
	const packageEntry = resolvePiPackageEntry(require);
	const exportModulePath = path.join(path.dirname(packageEntry), "core", "export-html", "index.js");
	const { exportSessionToHtml } = (await import(pathToFileURL(exportModulePath).href)) as {
		exportSessionToHtml: ExportSessionToHtml;
	};

	pi.registerCommand("share-as", {
		description: "Create a private GitHub gist using a custom name: /share-as <name>",
		handler: async (args, ctx) => {
			const requestedName = args.trim() || pi.getSessionName?.()?.trim?.() || "";
			if (!requestedName) {
				ctx.ui.notify("Usage: /share-as <name>", "warning");
				return;
			}

			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify("Cannot share an in-memory session. Save or start a normal session first.", "error");
				return;
			}

			try {
				const authResult = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
				if (authResult.status !== 0) {
					ctx.ui.notify("GitHub CLI is not logged in. Run 'gh auth login' first.", "error");
					return;
				}
			} catch {
				ctx.ui.notify("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/", "error");
				return;
			}

			await ctx.waitForIdle();

			const tmpFile = path.join(os.tmpdir(), "session.html");

			try {
				const allTools = new Map((pi.getAllTools?.() ?? []).map((tool: any) => [tool.name, tool] as const));
				const activeTools = (pi.getActiveTools?.() ?? [])
					.map((name: string) => allTools.get(name))
					.filter((tool: any) => Boolean(tool))
					.map((tool: any) => ({
						name: tool.name,
						description: tool.description,
						parameters: tool.parameters,
					}));

				let systemPrompt: string | undefined;
				try {
					systemPrompt = ctx.getSystemPrompt?.();
				} catch {
					systemPrompt = undefined;
				}

				await exportSessionToHtml(
					ctx.sessionManager,
					{
						systemPrompt,
						tools: activeTools,
					},
					tmpFile,
				);
			} catch (error) {
				ctx.ui.notify(
					`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`,
					"error",
				);
				return;
			}

			try {
				const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
					const proc = spawn("gh", ["gist", "create", "--public=false", "--desc", requestedName, tmpFile]);
					let stdout = "";
					let stderr = "";
					proc.stdout?.on("data", (data) => {
						stdout += data.toString();
					});
					proc.stderr?.on("data", (data) => {
						stderr += data.toString();
					});
					proc.on("close", (code) => resolve({ stdout, stderr, code }));
				});

				if (result.code !== 0) {
					ctx.ui.notify(`Failed to create gist: ${result.stderr.trim() || "Unknown error"}`, "error");
					return;
				}

				const gistUrl = result.stdout
					.trim()
					.split(/\s+/)
					.find((part) => part.startsWith("https://gist.github.com/"));
				const gistId = gistUrl?.split("/").pop();
				if (!gistUrl || !gistId) {
					ctx.ui.notify("Failed to parse gist URL from gh output.", "error");
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
				ctx.ui.notify(`Created gist '${requestedName}'`, "success");
				ctx.ui.notify(`Share URL: ${previewUrl}`, "info");
			} catch (error) {
				ctx.ui.notify(
					`Failed to create gist: ${error instanceof Error ? error.message : "Unknown error"}`,
					"error",
				);
			} finally {
				try {
					fs.unlinkSync(tmpFile);
				} catch {
					// Ignore cleanup errors.
				}
			}
		},
	});
}
