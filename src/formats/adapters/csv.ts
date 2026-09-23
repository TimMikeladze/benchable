import { FormatParseError, type FormatAdapter, type MetricValue } from "../types";
import {compactMetric, metricKey, precise, round } from "../util";

/**
 * The escape hatch: `name,value[,unit[,direction]]`, with or without a header row.
 * Anything that can print two columns can feed Benchable.
 */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else quoted = false;
      } else current += char;
    } else if (char === '"') quoted = true;
    else if (char === "," || char === "\t" || char === ";") {
      cells.push(current.trim());
      current = "";
    } else current += char;
  }
  cells.push(current.trim());
  return cells;
}

function isHeader(cells: string[]): boolean {
  return cells.length >= 2 && !Number.isFinite(Number(cells[1]));
}

export const csv: FormatAdapter = {
  id: "csv",
  label: "CSV",
  description: "Two to four columns: name, value, optional unit, optional lower|higher.",
  produce: 'printf "build.time_ms,4210,ms\\napi.rps,1840,ops/s,higher\\n" > bench.csv',

  detect(input) {
    if (input.json !== null) return false;
    const rows = input.raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    if (rows.length === 0) return false;

    const parsed = rows.map(splitRow);
    const body = isHeader(parsed[0]) ? parsed.slice(1) : parsed;
    if (body.length === 0) return false;
    return body.every((cells) => cells.length >= 2 && Number.isFinite(Number(cells[1])));
  },

  parse(input) {
    const rows = input.raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map(splitRow);
    if (rows.length === 0) throw new FormatParseError("No rows", "csv");

    const body = isHeader(rows[0]) ? rows.slice(1) : rows;
    const metrics: Record<string, MetricValue> = {};

    for (const cells of body) {
      const [name, rawValue, unit, direction] = cells;
      const value = Number(rawValue);
      if (!name || !Number.isFinite(value)) continue;
      metrics[metricKey(name)] = compactMetric({
        value: precise(value),
        unit: unit || undefined,
        direction: direction === "higher" || direction === "lower" ? direction : undefined,
      });
    }

    if (Object.keys(metrics).length === 0) {
      throw new FormatParseError("No rows had a name and a numeric value", "csv");
    }

    return { format: "csv", metrics };
  },
};
