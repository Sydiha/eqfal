import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Accounting } from "../components/Accounting";
import i18n from "../i18n";

const journals = [
  {
    id: "journal-draft",
    fiscal_year_id: "year",
    accounting_date: "2026-01-01",
    description: "Arabic مصروف",
    reference: "REF-1",
    entry_type: "standard" as const,
    status: "draft" as const,
  },
  {
    id: "journal-posted",
    fiscal_year_id: "year",
    accounting_date: "2026-01-31",
    description: "Opening",
    reference: null,
    entry_type: "opening_balance" as const,
    status: "posted" as const,
  },
];
const sources = [
  {
    source_type: "obligation",
    source_id: "source-negative",
    accounting_date: "2026-01-01",
    amount: "-12.50",
    description: "مورد",
    reference: "SRC-1",
  },
  {
    source_type: "document_settlement",
    source_id: "source-positive",
    accounting_date: "2026-01-31",
    amount: "50.00",
    description: "Settlement",
    reference: null,
  },
];
const year = {
  id: "year",
  name: "2026",
  start_date: "2026-01-01",
  end_date: "2026-12-31",
};
function mockApi(journalRows = journals, sourceRows = sources) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/accounts")
        return new Response(JSON.stringify({ accounts: [] }));
      if (url === "/api/fiscal-years")
        return new Response(JSON.stringify({ fiscalYears: [year] }));
      if (url === "/api/journals" && options?.method === "POST")
        return new Response(JSON.stringify(journals[0]), { status: 201 });
      if (url === "/api/journals")
        return new Response(JSON.stringify({ journals: journalRows }));
      return new Response(JSON.stringify({ sources: sourceRows }));
    }),
  );
}
const renderAccounting = () =>
  render(
    <Accounting
      canView
      canCreateChart={false} canEditChart={false}
      canCreateJournal
      canEditJournal
      canPost
      onUnauthorized={vi.fn()}
    />,
  );

describe("Accounting operational discovery", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.history.replaceState(null, "", "/?page=accounting");
    mockApi();
  });
  it.each([
    ["journals", "Journals"],
    ["sources", "Operational Sources"],
  ])("restores the %s tab from URL", async (tab, name) => {
    window.history.replaceState(
      null,
      "",
      `/?page=accounting&accountingTab=${tab}`,
    );
    renderAccounting();
    expect(await screen.findByRole("tab", { name })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
  it("falls back for invalid tabs, writes tab changes, and restores popstate", async () => {
    window.history.replaceState(
      null,
      "",
      "/?page=accounting&accountingTab=invalid&safe=1",
    );
    renderAccounting();
    expect(
      await screen.findByRole("tab", { name: "Chart of Accounts" }),
    ).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Journals" }));
    expect(location.search).toContain("accountingTab=journals");
    expect(location.search).toContain("safe=1");
    window.history.pushState(
      null,
      "",
      "/?page=accounting&accountingTab=sources",
    );
    fireEvent(window, new PopStateEvent("popstate"));
    expect(
      screen.getByRole("tab", { name: "Operational Sources" }),
    ).toHaveAttribute("aria-selected", "true");
  });
  it("filters journals by search, status, type, and inclusive dates and clears only journal state", async () => {
    window.history.replaceState(
      null,
      "",
      "/?page=accounting&accountingTab=journals&journalSearch=%D9%85%D8%B5%D8%B1%D9%88%D9%81&journalStatus=draft&journalEntryType=standard&journalFrom=2026-01-01&journalTo=2026-01-01&sourceSearch=keep",
    );
    renderAccounting();
    expect(
      await screen.findByRole("button", { name: /Arabic/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Opening/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "" })).toBeDefined();
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search journals" }),
      { target: { value: "missing" } },
    );
    expect(
      (
        await screen.findByText(
          "No journals match the current search and filters.",
        )
      ).parentElement,
    ).toHaveAttribute("data-state", "no-results");
    expect(screen.getByText("0 journals")).toBeInTheDocument();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Clear filters" })[0]!,
    );
    expect(location.search).toContain("accountingTab=journals");
    expect(location.search).toContain("sourceSearch=keep");
    expect(location.search).not.toContain("journalSearch");
  });
  it("ignores invalid journal filter values and distinguishes a genuine empty state", async () => {
    window.history.replaceState(
      null,
      "",
      "/?page=accounting&accountingTab=journals&journalStatus=void&journalFrom=2026-02-30",
    );
    renderAccounting();
    expect(
      await screen.findAllByRole("button", { name: /Arabic|Opening/ }),
    ).toHaveLength(2);
    mockApi([], sources);
    window.history.replaceState(
      null,
      "",
      "/?page=accounting&accountingTab=journals",
    );
    renderAccounting();
    expect(
      (await screen.findByText("No journals yet.")).parentElement,
    ).toHaveAttribute("data-state", "empty");
  });
  it("filters sources by text, derived type, inclusive dates, and signed amount bounds", async () => {
    window.history.replaceState(
      null,
      "",
      "/?page=accounting&accountingTab=sources&sourceFrom=2026-01-01&sourceTo=2026-01-01&sourceAmountMin=-13&sourceAmountMax=-12",
    );
    renderAccounting();
    expect(await screen.findByText("مورد")).toBeInTheDocument();
    expect(screen.queryByText("Settlement")).not.toBeInTheDocument();
    expect(screen.getByText("1 sources")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Source type"), {
      target: { value: "document_settlement" },
    });
    expect(
      (
        await screen.findByText(
          "No operational sources match the current search and filters.",
        )
      ).parentElement,
    ).toHaveAttribute("data-state", "no-results");
    expect(screen.getByText("0 sources")).toBeInTheDocument();
  });
  it("ignores invalid source values and keeps journal/source parameters isolated when clearing", async () => {
    window.history.replaceState(
      null,
      "",
      "/?page=accounting&accountingTab=sources&sourceType=made_up&sourceAmountMin=nope&journalStatus=draft",
    );
    renderAccounting();
    expect(await screen.findByText("مورد")).toBeInTheDocument();
    expect(screen.getByText("Settlement")).toBeInTheDocument();
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search operational sources" }),
      { target: { value: "SRC-1" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(location.search).toContain("journalStatus=draft");
    expect(location.search).toContain("accountingTab=sources");
  });
  it("creates a journal under active source filters and synchronizes the visible tab and URL", async () => {
    window.history.replaceState(
      null,
      "",
      "/?page=accounting&accountingTab=sources&sourceSearch=SRC-1",
    );
    renderAccounting();
    fireEvent.click(
      await screen.findByRole("button", { name: "Create draft journal" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Journals" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    expect(location.search).toContain("accountingTab=journals");
    expect(location.search).toContain("sourceSearch=SRC-1");
  });
});
