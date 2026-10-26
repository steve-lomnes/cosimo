import { describe, expect, test } from "bun:test";
import { dueToAccountId } from "./receipts";

const acct = (id: string, name: string, type = "liability", is_active = true) => ({
  id,
  name,
  type,
  is_active,
});

describe("dueToAccountId", () => {
  test("the one active liability named Due to …", () => {
    expect(
      dueToAccountId([
        acct("a", "Accounts Payable"),
        acct("d", "Due to Owner"),
        acct("e", "Due to x", "equity"),
      ]),
    ).toBe("d");
  });

  test("none, or more than one, gives no default", () => {
    expect(dueToAccountId([acct("a", "Accounts Payable")])).toBeNull();
    expect(dueToAccountId([acct("d1", "Due to Partners"), acct("d2", "Due to Owner")])).toBeNull();
    expect(dueToAccountId([acct("d", "Due to Owner", "liability", false)])).toBeNull();
  });
});
