import nodeFs from "node:fs";
import path from "node:path";
import { readIfExistsSync } from "../util/read-if-exists.js";

export interface InstallFs {
    read     : (file: string) => string | undefined;
    writeFile: (file: string, text: string) => void;
    copy     : (from: string, to: string) => void;
    lock     : (file: string) => () => void;
}

export const realFs: InstallFs = {
    read     : readIfExistsSync,
    writeFile: (file, text) => {
        let target = file;
        let mode = 0o600;

        try {
            target = nodeFs.realpathSync(file);
            mode = nodeFs.statSync(target).mode & 0o777;
        } catch {
            nodeFs.mkdirSync(path.dirname(file), { recursive: true });
        }

        const temp = `${target}.tmp-${process.pid}`;

        try {
            nodeFs.writeFileSync(temp, text, { mode });
            nodeFs.renameSync(temp, target);
        } catch (error) {
            nodeFs.rmSync(temp, { force: true });

            throw error;
        }
    },
    copy: (from, to) => nodeFs.copyFileSync(from, to, nodeFs.constants.COPYFILE_EXCL),
    lock: (file) => {
        nodeFs.mkdirSync(path.dirname(file), { recursive: true });
        let target: string;

        try {
            target = nodeFs.realpathSync(file);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

            try {
                nodeFs.lstatSync(file);

                throw new Error(`Cannot lock ${file} because its target is missing.`);
            } catch (failure) {
                if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure;
            }

            target = path.join(nodeFs.realpathSync(path.dirname(file)), path.basename(file));
        }

        const lockFile = `${target}.chromium-devtools-install.lock`;
        let descriptor: number;

        try {
            descriptor = nodeFs.openSync(lockFile, "wx", 0o600);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

            throw new Error(`another installer may be using ${file}. If no installer is running, remove ${lockFile} and retry`);
        }

        return () => {
            try {
                nodeFs.closeSync(descriptor);
            } finally {
                nodeFs.unlinkSync(lockFile);
            }
        };
    },
};
