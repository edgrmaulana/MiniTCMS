import { describe, expect, it } from "vitest";
import {
  MappingError,
  assertSectionPath,
  labelledIdMap,
  mapCase,
  mapCaseField,
  mapResult,
  mapSection,
  mapUser,
  stripCustomPrefix,
  trColorToHex,
  isValidTimeZone,
  parseCsvTimestamp,
  parseSourceId,
  parseUserMap,
  priorityFromLabel,
  slugifyFieldName,
  splitSectionPath,
  templateFromLabel,
  typeFromLabel,
} from "./map";
import {
  CASE_PRIORITY,
  CASE_TEMPLATE,
  CASE_TYPE,
  MAX_SECTION_LEVELS,
  RESULT_STATUS,
} from "../format";

describe("source ids", () => {
  it("strips one entity letter", () => {
    expect(parseSourceId("C1234567", "Case")).toBe(1234567);
    expect(parseSourceId("S928", "Suite")).toBe(928);
    expect(parseSourceId(" 42 ", "Case")).toBe(42);
  });

  it("refuses anything that is not one letter and digits", () => {
    expect(() => parseSourceId("CASE-7", "Case")).toThrow(MappingError);
    expect(() => parseSourceId("", "Case")).toThrow(MappingError);
    expect(() => parseSourceId("C0", "Case")).toThrow(MappingError);
  });
});

describe("labels to ids", () => {
  it("matches priority and type case-insensitively", () => {
    expect(priorityFromLabel("Medium")).toBe(CASE_PRIORITY.medium);
    expect(priorityFromLabel("  CRITICAL ")).toBe(CASE_PRIORITY.critical);
    expect(typeFromLabel("Other")).toBe(CASE_TYPE.other);
  });

  it("returns null for an unknown label rather than falling back to other", () => {
    expect(priorityFromLabel("Urgent")).toBeNull();
    expect(typeFromLabel("Smoke & Sanity")).toBeNull();
    expect(typeFromLabel("")).toBeNull();
  });

  it("treats an unknown template as a hard error", () => {
    expect(templateFromLabel("Test Case (Text)")).toBe(CASE_TEMPLATE.text);
    expect(templateFromLabel("test case (steps)")).toBe(CASE_TEMPLATE.steps);
    expect(() => templateFromLabel("Test Case (BDD)")).toThrow(MappingError);
  });
});

describe("section paths", () => {
  it("splits on the separator and trims", () => {
    expect(splitSectionPath("a > b > c")).toEqual(["a", "b", "c"]);
  });

  it("accepts a path whose depth and leaf agree", () => {
    expect(() =>
      assertSectionPath(["a", "b", "c"], { depth: 2, leaf: "c" }, "C1"),
    ).not.toThrow();
  });

  it("names the case when the depth disagrees with the segment count", () => {
    expect(() => assertSectionPath(["a", "b"], { depth: 2, leaf: "b" }, "C9")).toThrow(/C9/);
  });

  it("names the case when the leaf is not the last segment", () => {
    expect(() => assertSectionPath(["a", "b"], { depth: 1, leaf: "z" }, "C9")).toThrow(/C9/);
  });

  it("rejects a path deeper than the schema allows", () => {
    // Built from the constant, so raising the cap moves the test with it
    // instead of leaving a hardcoded depth that no longer proves anything.
    const deep = Array.from({ length: MAX_SECTION_LEVELS + 1 }, (_, index) => `s${index}`);
    const leaf = deep[deep.length - 1];
    expect(() =>
      assertSectionPath(deep, { depth: MAX_SECTION_LEVELS, leaf }, "C9"),
    ).toThrow(/levels deep/);
  });

  it("accepts a path at exactly the cap", () => {
    const atCap = Array.from({ length: MAX_SECTION_LEVELS }, (_, index) => `s${index}`);
    const leaf = atCap[atCap.length - 1];
    expect(() =>
      assertSectionPath(atCap, { depth: MAX_SECTION_LEVELS - 1, leaf }, "C9"),
    ).not.toThrow();
  });
});

describe("field names", () => {
  it("slugifies a header", () => {
    expect(slugifyFieldName("Business_Unit")).toBe("business_unit");
    expect(slugifyFieldName("Test in PROD")).toBe("test_in_prod");
    expect(slugifyFieldName("Steps (Additional Info)")).toBe("steps_additional_info");
  });

  it("keeps a name that would start with a digit usable", () => {
    expect(slugifyFieldName("2nd Reviewer")).toBe("f_2nd_reviewer");
  });

  it("refuses a header with nothing usable in it", () => {
    expect(() => slugifyFieldName("***")).toThrow(MappingError);
  });
});

describe("dates", () => {
  const utc = { dateOrder: "mdy", timeZone: "UTC" } as const;

  it("reads a 12-hour locale-ordered timestamp", () => {
    expect(parseCsvTimestamp("10/1/2026 6:26 PM", utc)).toBe(
      Date.UTC(2026, 9, 1, 18, 26) / 1000,
    );
  });

  it("reads the same digits differently under each date order", () => {
    const mdy = parseCsvTimestamp("1/2/2026", { dateOrder: "mdy", timeZone: "UTC" });
    const dmy = parseCsvTimestamp("1/2/2026", { dateOrder: "dmy", timeZone: "UTC" });
    expect(mdy).toBe(Date.UTC(2026, 0, 2) / 1000);
    expect(dmy).toBe(Date.UTC(2026, 1, 1) / 1000);
  });

  it("applies the zone offset", () => {
    expect(parseCsvTimestamp("10/1/2026 6:26 PM", { dateOrder: "mdy", timeZone: "Asia/Jakarta" })).toBe(
      Date.UTC(2026, 9, 1, 11, 26) / 1000,
    );
  });

  it("uses the offset in force on the day, not a fixed one", () => {
    const winter = parseCsvTimestamp("1/15/2026 12:00 PM", {
      dateOrder: "mdy",
      timeZone: "America/New_York",
    });
    const summer = parseCsvTimestamp("7/15/2026 12:00 PM", {
      dateOrder: "mdy",
      timeZone: "America/New_York",
    });
    expect(winter).toBe(Date.UTC(2026, 0, 15, 17, 0) / 1000);
    expect(summer).toBe(Date.UTC(2026, 6, 15, 16, 0) / 1000);
  });

  it("separates an empty cell from an unreadable one", () => {
    expect(parseCsvTimestamp("   ", utc)).toBeNull();
    expect(() => parseCsvTimestamp("yesterday", utc)).toThrow(MappingError);
    expect(() => parseCsvTimestamp("13/40/2026", utc)).toThrow(MappingError);
    expect(() => parseCsvTimestamp("10/1/2026 13:00 PM", utc)).toThrow(MappingError);
  });

  it("knows a real zone from a made-up one", () => {
    expect(isValidTimeZone("Asia/Jakarta")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });
});

describe("user map", () => {
  it("reads name=email pairs, lowercased", () => {
    const map = parseUserMap("Ana=Ana@Example.com, bo = bo@example.com");
    expect(map.get("ana")).toBe("ana@example.com");
    expect(map.get("ana")).toBe("ana@example.com");
  });

  it("refuses an entry that is not a pair", () => {
    expect(() => parseUserMap("ana")).toThrow(MappingError);
  });
});

describe("api mappers", () => {
  const empty = new Map<number, number>();

  it("converts a packed TestRail colour to hex", () => {
    expect(trColorToHex(0x37b9d8)).toBe("#37b9d8");
    expect(trColorToHex(0)).toBe("#000000");
    expect(trColorToHex(null)).toBeNull();
    expect(trColorToHex(0x1000000)).toBeNull();
  });

  it("strips the custom_ prefix and keeps phase 2's names for the step fields", () => {
    expect(stripCustomPrefix("custom_business_unit")).toBe("business_unit");
    expect(stripCustomPrefix("custom_steps")).toBe("steps_text");
    expect(stripCustomPrefix("custom_steps_separated")).toBe("steps");
    expect(stripCustomPrefix("title")).toBe("title");
  });

  it("refuses a user with no email rather than inventing one", () => {
    expect(() => mapUser({ id: 4, name: "Nameless" })).toThrow(MappingError);
  });

  it("keeps an unknown field type and names it", () => {
    const mapped = mapCaseField({ id: 2, type_id: 99, system_name: "custom_mystery" });
    expect(mapped.type).toBe("testrail_99");
    expect(mapped.systemName).toBe("mystery");
    expect(mapped.unmapped).toHaveLength(1);
  });

  it("rejects a section deeper than the schema allows", () => {
    expect(() =>
      mapSection(
        { id: 9, name: "Deep", depth: MAX_SECTION_LEVELS },
        { suiteId: 1, sectionIds: empty, source: "testrail" },
      ),
    ).toThrow(new RegExp(`depth ${MAX_SECTION_LEVELS}`));
  });

  it("accepts a section one level inside the cap", () => {
    expect(() =>
      mapSection(
        { id: 9, name: "Deepest allowed", depth: MAX_SECTION_LEVELS - 1, parent_id: null },
        { suiteId: 1, sectionIds: empty, source: "testrail" },
      ),
    ).not.toThrow();
  });

  it("reports a parent that was never imported instead of writing a dangling id", () => {
    const mapped = mapSection(
      { id: 9, name: "Orphan", parent_id: 404, depth: 1 },
      { suiteId: 1, sectionIds: empty, source: "testrail" },
    );
    expect(mapped.row.parent_id).toBeNull();
    expect(mapped.unmapped).toEqual([
      { field: "parent_id", value: "TestRail id 404 was not imported" },
    ]);
  });

  it("falls back to the text template but says so", () => {
    const mapped = mapCase(
      { id: 1, title: "A case", template_id: 77, created_on: 1700000000 },
      {
        suiteId: 1,
        source: "testrail",
        sectionIds: empty,
        milestoneIds: empty,
        userIds: empty,
        priorityIds: empty,
        typeIds: empty,
        templateIds: empty,
      },
    );
    expect(mapped.row.template_id).toBe(CASE_TEMPLATE.text);
    expect(mapped.unmapped.some((entry) => entry.field === "template_id")).toBe(true);
  });

  it("refuses a result whose status was never imported", () => {
    expect(() =>
      mapResult(
        { id: 5, test_id: 80, status_id: 42 },
        { testIds: new Map([[80, 1]]), userIds: empty, knownStatusIds: new Set([1]), source: "testrail" },
      ),
    ).toThrow(/status 42/);
  });

  it("treats a comment-only result as carrying no verdict", () => {
    const mapped = mapResult(
      { id: 5, test_id: 80, comment: "just a note", created_on: 1700000000 },
      { testIds: new Map([[80, 1]]), userIds: empty, knownStatusIds: new Set([1]), source: "testrail" },
    );
    expect(mapped.row.status_id).toBe(RESULT_STATUS.untested);
    expect(mapped.row.comment).toBe("just a note");
  });

  it("builds a label map and lists what it could not match", () => {
    const { ids, unmatched } = labelledIdMap(
      [
        { id: 1, name: "Low" },
        { id: 9, name: "Urgent" },
      ],
      priorityFromLabel,
    );
    expect(ids.get(1)).toBe(CASE_PRIORITY.low);
    expect(ids.has(9)).toBe(false);
    expect(unmatched).toEqual([{ id: 9, label: "Urgent" }]);
  });
});
