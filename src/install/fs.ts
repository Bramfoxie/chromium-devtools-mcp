import nodeFs from "node:fs";
import path from "node:path";

export interface InstallFs {
    read     : (file: string) => string | undefined;
    writeFile: (file: string, text: string) => void;
    copy     : (from: string, to: string) => void;
}

export const realFs: InstallFs = {
    read: (file) => {
        try {
            return nodeFs.readFileSync(file, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;

            throw error;
        }
    },
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
    copy: (from, to) => nodeFs.copyFileSync(from, to),
};
