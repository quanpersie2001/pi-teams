import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function builtTaskBoardModule(): string {
	const dist = join(process.cwd(), "dist", "extensions");
	const chunk = readdirSync(dist).find((name) => {
		if (!name.startsWith("chunk-") || !name.endsWith(".js")) return false;
		return /export\s*\{[\s\S]*TaskBoardService/.test(readFileSync(join(dist, name), "utf8"));
	});
	if (!chunk) throw new Error("Built TaskBoardService chunk not found; run npm run build before integration tests");
	return pathToFileURL(join(dist, chunk)).href;
}

const childSource = `
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [moduleUrl, teamDir, barrierDir, worker] = process.argv.slice(1);
const { TaskBoardService } = await import(moduleUrl);
writeFileSync(join(barrierDir, worker + ".ready"), "ready");
const sleep = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(join(barrierDir, "go"))) Atomics.wait(sleep, 0, 0, 2);
const board = new TaskBoardService({ teamDir, self: "lead" });
const codes = [];
for (let index = 0; index < 4;) {
  try {
    codes.push(board.create({ title: worker + "-" + index }).code);
    index++;
  } catch (error) {
    if (!String(error?.message).includes("Task board conflict")) throw error;
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 8 + 1));
  }
}
process.stdout.write(JSON.stringify(codes));
`;

describe("cross-process task board lock recovery", () => {
	it("serializes simultaneous stale-lock reclaimers without duplicate task codes", async () => {
		const root = mkdtempSync(join(tmpdir(), "task-board-lock-race-"));
		try {
			const teamDir = join(root, "team");
			const taskDir = join(teamDir, "tasks");
			const barrierDir = join(root, "barrier");
			mkdirSync(taskDir, { recursive: true });
			mkdirSync(barrierDir);
			writeFileSync(join(taskDir, "board.lock"), "2147483647:dead-0000-0000-0000-000000000000");
			const moduleUrl = builtTaskBoardModule();
			const workers = ["first", "second"].map((worker) => {
				const child = spawn(
					process.execPath,
					["--input-type=module", "-e", childSource, moduleUrl, teamDir, barrierDir, worker],
					{ stdio: ["ignore", "pipe", "pipe"] },
				);
				let stdout = "";
				let stderr = "";
				child.stdout.setEncoding("utf8").on("data", (data: string) => (stdout += data));
				child.stderr.setEncoding("utf8").on("data", (data: string) => (stderr += data));
				return new Promise<string>((resolve, reject) => {
					child.on("error", reject);
					child.on("close", (code) => {
						if (code === 0) resolve(stdout);
						else reject(new Error(`Task lock worker exited ${code}: ${stderr}`));
					});
				});
			});

			const deadline = Date.now() + 10_000;
			while (
				(!readdirSync(barrierDir).includes("first.ready") || !readdirSync(barrierDir).includes("second.ready")) &&
				Date.now() < deadline
			)
				await pause(5);
			expect(readdirSync(barrierDir)).toContain("first.ready");
			expect(readdirSync(barrierDir)).toContain("second.ready");
			writeFileSync(join(barrierDir, "go"), "go");

			const codes = (await Promise.all(workers)).flatMap((output) => JSON.parse(output) as string[]);
			expect(codes).toHaveLength(8);
			expect(new Set(codes).size).toBe(8);
			expect(codes.sort()).toEqual(Array.from({ length: 8 }, (_, index) => `T${index + 1}`));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
