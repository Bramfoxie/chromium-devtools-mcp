#!/usr/bin/env node
import { main } from "./cli-main.js";
import { ignoreStreamErrors } from "./util/log.js";

ignoreStreamErrors();

process.exitCode = await main(process.argv.slice(2));
