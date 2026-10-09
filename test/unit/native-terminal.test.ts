import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Editor, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeTerminal, type NativeTerminal } from "../../extension-src/pi-teams/pi/native-terminal.js";

const TOKEN = "native-terminal-unit-secret";
let tempDir: string | undefined;
let terminal: NativeTerminal | undefined;
const sockets: Socket[] = [];

function deferred<T>() {
	return Promise.withResolvers<T>();
}

async function connectSocket(path: string): Promise<Socket> {
	const socket = connect(path);
	sockets.push(socket);
	await once(socket, "connect");
	return socket;
}

function send(socket: Socket, frame: Record<string, unknown>): void {
	socket.write(`${JSON.stringify(frame)}\n`);
}

function nextFrame(socket: Socket): Promise<Record<string, unknown>> {
	const result = deferred<Record<string, unknown>>();
	let data = "";
	const onData = (chunk: Buffer): void => {
		data += chunk.toString("utf8");
		const newline = data.indexOf("\n");
		if (newline < 0) return;
		socket.removeListener("data", onData);
		result.resolve(JSON.parse(data.slice(0, newline)) as Record<string, unknown>);
	};
	socket.on("data", onData);
	return result.promise;
}

async function attach(columns = 93, rows = 37): Promise<Socket> {
	if (!tempDir) throw new Error("Native terminal fixture has not been initialized");
	const socket = await connectSocket(join(tempDir, "terminal.sock"));
	const ready = nextFrame(socket);
	send(socket, { type: "auth", childId: "child-native-1", token: TOKEN });
	expect(await ready).toMatchObject({ type: "ready" });
	send(socket, { type: "resize", columns, rows });
	await vi.waitFor(() => {
		expect(terminal?.columns).toBe(columns);
		expect(terminal?.rows).toBe(rows);
	});
	return socket;
}

afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.destroy();
	await terminal?.close();
	terminal = undefined;
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

describe("native terminal Unix transport", () => {
	it("supports Pi 1.1 program status reports during interactive startup", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-teams-terminal-"));
		terminal = await createNativeTerminal({
			socketPath: join(tempDir, "terminal.sock"),
			childId: "child-native-1",
			token: TOKEN,
		});
		const socket = await attach();
		const output = nextFrame(socket);
		terminal.setProgramStatus({ state: "idle", app: "pi" });
		expect(Buffer.from(String((await output).data), "base64").toString("utf8")).toBe(
			"\u001b]7501;state=idle:app=pi\u001b\\",
		);
	});

	it("rejects an unauthenticated replacement without interrupting the authorized presentation", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-teams-terminal-"));
		terminal = await createNativeTerminal({
			socketPath: join(tempDir, "terminal.sock"),
			childId: "child-native-1",
			token: TOKEN,
		});
		const authorized = await attach();
		const unauthorized = await connectSocket(join(tempDir, "terminal.sock"));
		const rejected = once(unauthorized, "close");
		send(unauthorized, { type: "auth", childId: "child-native-1", token: "wrong" });
		await rejected;
		const output = nextFrame(authorized);
		terminal.write("authorized native presentation");
		expect(Buffer.from(String((await output).data), "base64").toString("utf8")).toBe("authorized native presentation");
	});

	it("keeps the native terminal alive across disconnect and repaints on same-size reconnect", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-teams-terminal-"));
		terminal = await createNativeTerminal({
			socketPath: join(tempDir, "terminal.sock"),
			childId: "child-native-1",
			token: TOKEN,
		});
		let input = "";
		const inputReceived = deferred<string>();
		const pasteReceived = deferred<string>();
		const reconnectedInput = deferred<string>();
		const resized = deferred<void>();
		let resizeCount = 0;
		let repaintCount = 0;
		const inputEvents: string[] = [];
		const handleInput = (data: string): void => {
			inputEvents.push(data);
			input += data;
			inputReceived.resolve(input);
			if (data.startsWith("\u001b[200~")) pasteReceived.resolve(data);
			if (input.endsWith("again")) reconnectedInput.resolve(input);
		};
		const handleResize = (): void => {
			resizeCount++;
			if (terminal.columns === 101 && terminal.rows === 42) resized.resolve();
		};
		terminal.start(handleInput, handleResize);
		terminal.setRepaint(() => {
			repaintCount++;
		});
		const first = await attach();
		const firstOutput = nextFrame(first);
		terminal.write("\u001b[31mNative TUI\u001b[0m\r\n");
		const output = await firstOutput;
		expect(Buffer.from(String(output.data), "base64").toString("utf8")).toBe("\u001b[31mNative TUI\u001b[0m\r\n");
		terminal.stop();
		expect(first.destroyed).toBe(false);
		terminal.start(handleInput, handleResize);
		send(first, {
			type: "input",
			data: Buffer.from("hello\r").toString("base64"),
			final: true,
			kittyProtocolActive: true,
		});
		send(first, { type: "resize", columns: 101, rows: 42 });
		expect(await inputReceived.promise).toBe("hello\r");
		await resized.promise;
		const pasteText = `\u001b[200~x${"🧪".repeat(8_000)}\u001b[201~`;
		const pasteBytes = Buffer.from(pasteText);
		const pasteSplit = 24 * 1024;
		expect(pasteBytes[pasteSplit - 1]).toBe(0xf0);
		send(first, {
			type: "input",
			data: pasteBytes.subarray(0, pasteSplit).toString("base64"),
			final: false,
			kittyProtocolActive: true,
		});
		send(first, {
			type: "input",
			data: pasteBytes.subarray(pasteSplit).toString("base64"),
			final: true,
			kittyProtocolActive: true,
		});
		expect(await pasteReceived.promise).toBe(pasteText);
		expect(inputEvents).toEqual(["hello\r", pasteText]);
		expect(terminal.columns).toBe(101);
		expect(terminal.rows).toBe(42);
		expect(terminal.kittyProtocolActive).toBe(true);
		const countAfterFirst = repaintCount;
		const firstClosed = once(first, "close");
		const second = await attach(101, 42);
		await firstClosed;
		expect(first.destroyed).toBe(true);
		expect(repaintCount).toBe(countAfterFirst + 1);
		expect(resizeCount).toBeGreaterThanOrEqual(2);
		send(second, {
			type: "input",
			data: Buffer.from("again").toString("base64"),
			final: true,
			kittyProtocolActive: true,
		});
		expect(await reconnectedInput.promise).toBe(`hello\r${pasteText}again`);
		const secondOutput = nextFrame(second);
		terminal.write("repainted native frame");
		expect(Buffer.from(String((await secondOutput).data), "base64").toString("utf8")).toBe("repainted native frame");
		expect(input).toBe(`hello\r${pasteText}again`);
	});

	it("preserves native multiline editing under the attached Kitty keyboard protocol", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-teams-terminal-"));
		terminal = await createNativeTerminal({
			socketPath: join(tempDir, "terminal.sock"),
			childId: "child-native-1",
			token: TOKEN,
		});
		const tui = new TuiMainScreen(terminal);
		const editor = new Editor(tui, {
			borderColor: (text) => text,
			selectList: getSelectListTheme(),
		});
		const submitted: string[] = [];
		editor.onSubmit = (text) => submitted.push(text);
		tui.addChild(editor);
		tui.setFocus(editor);
		tui.start();
		try {
			const socket = await attach();
			for (const data of ["first line", "\n", "second line"]) {
				send(socket, {
					type: "input",
					data: Buffer.from(data).toString("base64"),
					final: true,
					kittyProtocolActive: true,
				});
			}
			await vi.waitFor(() => expect(editor.getText()).toBe("first line\nsecond line"));
			expect(submitted).toEqual([]);
			send(socket, {
				type: "input",
				data: Buffer.from("\r").toString("base64"),
				final: true,
				kittyProtocolActive: true,
			});
			await vi.waitFor(() => expect(submitted).toEqual(["first line\nsecond line"]));
		} finally {
			tui.stop();
		}
	});
});
