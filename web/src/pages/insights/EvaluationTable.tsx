import type { ReactNode } from "react";
import { useI18n } from "../../i18n/index.tsx";
import { EmptyState } from "../../ui.tsx";
export function EvaluationTable({
  rows,
  columns,
}: {
  rows: any[];
  columns: Array<{ label: string; value: (row: any) => ReactNode }>;
}) {
  const { locale } = useI18n();
  if (!rows.length)
    return (
      <EmptyState
        title={
          locale === "en"
            ? "No matching evidence"
            : "Chưa có bằng chứng phù hợp"
        }
      />
    );
  return (
    <div className="table-wrap">
      <table className="ins-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.label}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.case_run_id ?? r.id ?? i}>
              {columns.map((c) => (
                <td key={c.label}>{c.value(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
