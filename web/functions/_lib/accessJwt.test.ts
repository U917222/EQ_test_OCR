import { describe, expect, it } from "vitest";
import { verifyAccessJwt } from "./accessJwt";

function passwordRequest(password: string) {
  return new Request("https://example.test/api", {
    headers: { "X-App-Password": password },
  });
}

describe("verifyAccessJwt shared-password authentication", () => {
  it("uses the explicitly configured application email", async () => {
    await expect(
      verifyAccessJwt(passwordRequest("secret"), {
        APP_ACCESS_PASSWORD: "secret",
        APP_ACCESS_EMAIL: "operator@example.com",
        CF_ACCESS_AUD: "",
        CF_ACCESS_TEAM_DOMAIN: "",
      }),
    ).resolves.toMatchObject({
      email: "operator@example.com",
      claims: { email: "operator@example.com", auth: "shared-password" },
    });
  });

  it("fails closed when no application email is configured", async () => {
    await expect(
      verifyAccessJwt(passwordRequest("secret"), {
        APP_ACCESS_PASSWORD: "secret",
        CF_ACCESS_AUD: "",
        CF_ACCESS_TEAM_DOMAIN: "",
      }),
    ).rejects.toMatchObject({
      status: 500,
      code: "internal",
      message: "Missing APP_ACCESS_EMAIL or MVP_OPERATOR_EMAIL",
    });
  });
});
