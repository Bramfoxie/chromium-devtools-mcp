import type { DaemonAccess } from "../../mcp/index.js";
import { throwIfCancelled } from "../registry.js";
import type { CdpCommand } from "./commands.js";

interface EmulationStep {
    commands : CdpCommand[];
    record   : () => void;
    undo?    : CdpCommand[];
    unrecord?: () => void;
}

async function sendBestEffort(
    access  : DaemonAccess,
    targetId: string,
    commands: CdpCommand[],
): Promise<boolean> {
    try {
        for (const command of commands) {
            await access.send(targetId, command.method, command.params);
        }

        return true;
    } catch {
        return false;
    }
}

// Records each step after its commands are sent; on failure or cancel undoes what was sent.
export async function runSteps(
    access  : DaemonAccess,
    signal  : AbortSignal,
    targetId: string,
    steps   : EmulationStep[],
): Promise<void> {
    const done: EmulationStep[] = [];

    for (const step of steps) {
        let attempted = false;

        try {
            for (const command of step.commands) {
                throwIfCancelled(signal);
                attempted = true;
                await access.send(targetId, command.method, command.params);
            }
        } catch (error) {
            if (attempted && step.undo !== undefined) {
                await sendBestEffort(access, targetId, step.undo);
            }

            for (const finished of done.reverse()) {
                if (finished.undo === undefined) continue;

                const restored = await sendBestEffort(access, targetId, finished.undo);

                if (restored) finished.unrecord?.();
            }

            throw error;
        }

        step.record();
        done.push(step);
    }
}
