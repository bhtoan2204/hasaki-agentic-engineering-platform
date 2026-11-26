const fs = require("fs");
import { a } from "./a.js";
export function load(path) { return fs.readFileSync(path); }
export const save = (p, d) => fs.writeFileSync(p, d);
class Cache { get(k) { return this.m.get(k); } }
module.exports = { load };
