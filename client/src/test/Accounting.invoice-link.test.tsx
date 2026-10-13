import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Accounting } from "../components/Accounting";
import i18n from "../i18n";

const JOURNAL = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";
const row = (id: string, description: string) => ({ id, fiscal_year_id: "year", accounting_date: "2026-10-01", description, reference: null, entry_type: "standard" as const, status: "draft" as const });

function mockApi(detailCalls: string[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/accounts") return new Response(JSON.stringify({ accounts: [] }));
    if (url === "/api/fiscal-years") return new Response(JSON.stringify({ fiscalYears: [{ id: "year", name: "2026", start_date: "2026-01-01", end_date: "2026-12-31" }] }));
    if (url === "/api/journals") return new Response(JSON.stringify({ journals: [row(OTHER, "Other entry"), row(JOURNAL, "Purchase invoice 7")] }));
    if (url.startsWith("/api/journals/")) { detailCalls.push(url); return new Response(JSON.stringify({ ...row(JOURNAL, "Purchase invoice 7"), lines: [] })); }
    return new Response(JSON.stringify({ sources: [] }));
  }));
}
const renderAccounting = () => render(<Accounting canView canCreateChart={false} canEditChart={false} canCreateJournal canEditJournal canPost onUnauthorized={vi.fn()} />);

describe("Direct journal link from an invoice", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); });
  it("opens exactly the journal named by journalId on the journals tab", async () => {
    window.history.replaceState(null, "", `/?page=accounting&accountingTab=journals&journalId=${JOURNAL}`);
    const calls: string[] = [];
    mockApi(calls);
    renderAccounting();
    await screen.findByRole("heading", { name: "Selected journal" });
    expect(calls).toEqual([`/api/journals/${JOURNAL}`]);
  });
  it("opens nothing for an unknown or malformed journalId", async () => {
    for (const id of ["66666666-6666-4666-8666-666666666666", "not-a-uuid"]) {
      window.history.replaceState(null, "", `/?page=accounting&accountingTab=journals&journalId=${id}`);
      const calls: string[] = [];
      mockApi(calls);
      const { unmount } = renderAccounting();
      await screen.findByText("Other entry");
      await waitFor(() => expect(calls).toEqual([]));
      expect(screen.queryByRole("heading", { name: "Selected journal" })).not.toBeInTheDocument();
      unmount();
    }
  });
});
