import { describe, expect, it } from "vitest";

import { parseChannelSettings } from "./channels-input";
import { serverChannels, setupFrom, NO_CHANNEL_SETTINGS } from "./channels-data";

const cats = ["cca_injury", "bullying"];

describe("parseChannelSettings", () => {
  it("accepts switches, a template name and a clean sender list", () => {
    const r = parseChannelSettings(
      { whatsapp_enabled: true, whatsapp_template_name: " incident_notice ", whatsapp_template_language: "en_US", sms_enabled: false, email_in_enabled: true, email_in_senders: ["@School.edu", " aiman@school.edu ", "@school.edu", ""], email_in_category: "cca_injury" },
      cats,
    );
    expect(r).toEqual({
      ok: true,
      value: { whatsapp_enabled: true, whatsapp_template_name: "incident_notice", whatsapp_template_language: "en_US", sms_enabled: false, email_in_enabled: true, email_in_senders: ["@school.edu", "aiman@school.edu"], email_in_category: "cca_injury" },
    });
  });

  it("refuses what cannot work", () => {
    expect(parseChannelSettings({ whatsapp_template_name: "Incident Notice!" }, cats)).toMatchObject({ ok: false });
    expect(parseChannelSettings({ whatsapp_template_language: "english" }, cats)).toMatchObject({ ok: false });
    expect(parseChannelSettings({ email_in_senders: ["school.edu"] }, cats)).toMatchObject({ ok: false });
    expect(parseChannelSettings({ email_in_category: "made_up" }, cats)).toMatchObject({ ok: false });
    expect(parseChannelSettings({ sms_enabled: "yes" }, cats)).toMatchObject({ ok: false });
    expect(parseChannelSettings({ whatsapp_enabled: true, whatsapp_template_name: "" }, cats)).toMatchObject({ ok: false });
    expect(parseChannelSettings(null, cats)).toMatchObject({ ok: false });
  });

  it("clears the template and the category with null", () => {
    expect(parseChannelSettings({ whatsapp_template_name: null, email_in_category: null }, cats)).toEqual({ ok: true, value: { whatsapp_template_name: null, email_in_category: null } });
  });
});

describe("which channels a school can use", () => {
  const server = { sms: true, push: false };
  it("needs the switch, and what each channel needs behind it", () => {
    const on = { ...NO_CHANNEL_SETTINGS, whatsapp_enabled: true, whatsapp_template_name: "incident_notice", sms_enabled: true, push_enabled: true };
    expect(setupFrom(on, true, server)).toEqual({ whatsapp: true, sms: true, push: false }); // push is on but the server has no push API
    expect(setupFrom(on, false, server).whatsapp).toBe(false); // no WhatsApp number connected
    expect(setupFrom({ ...on, whatsapp_template_name: null }, true, server).whatsapp).toBe(false); // no template
    expect(setupFrom(NO_CHANNEL_SETTINGS, true, { sms: true, push: true })).toEqual({ whatsapp: false, sms: false, push: false });
  });

  it("knows what the server is set up for", () => {
    expect(serverChannels({})).toEqual({ sms: false, push: false });
    expect(serverChannels({ INCIDENT_SMS_URL: "https://b", INCIDENT_SMS_TOKEN: "t", INCIDENT_PUSH_API_URL: "https://p", INCIDENT_PUSH_API_KEY: "k", INCIDENT_PUSH_API_STAGE: "uat" })).toEqual({ sms: true, push: true });
    expect(serverChannels({ INCIDENT_PUSH_API_URL: "https://p", INCIDENT_PUSH_API_KEY: "k", INCIDENT_PUSH_API_STAGE: "staging" }).push).toBe(false);
  });
});
