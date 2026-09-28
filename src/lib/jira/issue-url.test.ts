import { describe, expect, it } from "vitest";
import { matchJiraIssueKey } from "./issue-url";

describe("matchJiraIssueKey", () => {
  it("matches a plain browse URL", () => {
    expect(matchJiraIssueKey("https://vircle.atlassian.net/browse/VC-1738")).toBe("VC-1738");
  });

  it("matches with a trailing slash, query string or hash", () => {
    expect(matchJiraIssueKey("https://vircle.atlassian.net/browse/VC-1738/")).toBe("VC-1738");
    expect(matchJiraIssueKey("https://vircle.atlassian.net/browse/VC-1738?atlOrigin=abc")).toBe("VC-1738");
    expect(matchJiraIssueKey("https://vircle.atlassian.net/browse/VC-1738#comment-1")).toBe("VC-1738");
  });

  it("uppercases a lowercase key", () => {
    expect(matchJiraIssueKey("https://vircle.atlassian.net/browse/vc-1738")).toBe("VC-1738");
  });

  it("works for http and any subdomain", () => {
    expect(matchJiraIssueKey("http://my-team.atlassian.net/browse/ABC-1")).toBe("ABC-1");
  });

  it("rejects a non-Jira URL", () => {
    expect(matchJiraIssueKey("https://example.com/browse/VC-1738")).toBeNull();
  });

  it("rejects an atlassian.net URL that isn't a /browse/ issue link", () => {
    expect(matchJiraIssueKey("https://vircle.atlassian.net/jira/software/projects/VC/boards/1")).toBeNull();
    expect(matchJiraIssueKey("https://vircle.atlassian.net/browse/VC")).toBeNull();
  });

  it("rejects garbage", () => {
    expect(matchJiraIssueKey("not a url")).toBeNull();
    expect(matchJiraIssueKey("")).toBeNull();
  });
});
