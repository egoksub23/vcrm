// ============================================================
// Merchant Registration (add-on `merchant`), version 2.0.
//
// What it installs, as drafts to review:
//   * the category "Merchant agreements";
//   * the template "Merchant Application": a 4 page A4 PDF drawn by scripts/build-merchant-template.ts (no
//     real merchant's form is used or copied; it is workspace-neutral and in English with Bahasa Melayu
//     beside it), the placed fields on it, the roles (merchant, optional finance filler, director) and the
//     form (the parts and data fields of Appendix A: company and tax, address and contacts, bank account,
//     documents, commercial terms, review and sign), with wording in English and Bahasa Melayu and labels in
//     Chinese and Korean for the fields that matter.
//
// Nothing here is a legal text. The fees and the nine key terms are headings with a placeholder paragraph
// ("[Insert the agreed wording]") the sender replaces in the template editor; different groups of merchants
// are different templates (duplicate the template). The signing consent stays the workspace's own or the
// product default until the owner has the wording reviewed.
//
// The template file and a summary of its layout are committed in ./merchant/assets/. The layout, the PDF
// and the placements all come from ./merchant/layout.ts, and a test fails if they drift apart.
//
// Versions (`changes` is what an administrator reads before pressing Update; `history` is what lets an update tell a template nobody
// edited from one that was edited, see update.ts)
//   1.0  the category only
//   1.1  adds the Merchant Application template and its form
//   2.0  the form's choices use the workspace's shared option lists, and the bank account and business registration number are
//        sensitive answers. The PDF, the placements, the roles and the wording are unchanged.
// ============================================================

import type { AddonManifest } from "./index";
import { MERCHANT_FORM, MERCHANT_FORM_V1, MERCHANT_ROLES } from "./merchant/form";
import { MERCHANT_PLACEMENTS } from "./merchant/layout";

const MERCHANT_DEFAULTS = { code_required: false, sign_in_order: false, locale: "en", expiry_days: 30, reminder_days: [3, 7] } as const;

/** The template file, relative to src/lib/sign/addons/merchant/. */
export const MERCHANT_TEMPLATE_SOURCE = "assets/merchant-application.pdf";

export const merchantAddon: AddonManifest = {
  key: "merchant",
  // 2.0: shared option lists and sensitive answers. 1.1 added the Merchant Application template and its form (1.0 only had the category)
  version: "2.0",
  nameKey: "merchant.name",
  // not "merchant.description": the 1.0 text said the template was still to come
  descriptionKey: "merchant.about",
  requires: "sign_merchant",
  category: {
    // the same key the starting categories use (sign_ensure_defaults), so a workspace gets one category, not two
    key: "merchant_agreements",
    name: "Merchant agreements",
    description: "Agreements signed by merchants who join.",
    presets: {},
  },
  templates: [
    {
      name: "Merchant Application",
      description: "The application a merchant fills in parts and signs: company and tax, contacts, bank account, documents, commercial terms. Add the agreed fees and terms before use.",
      source: MERCHANT_TEMPLATE_SOURCE,
      roles: MERCHANT_ROLES,
      fields: MERCHANT_PLACEMENTS,
      form: MERCHANT_FORM,
      defaults: { ...MERCHANT_DEFAULTS, reminder_days: [...MERCHANT_DEFAULTS.reminder_days] },
      tags: ["merchant", "application", "e-invoice"],
    },
  ],
  changes: [
    {
      version: "2.0",
      items: {
        en: [
          "State, country, bank, company ID type, e-invoice phase and tax type now take their choices from your shared lists (Settings > Doc Sign > Lists), so a bank or a state is changed once for every form.",
          "Business MSIC codes are picked from the full MSIC list with a search box instead of being typed in.",
          "The bank account number and the business registration number are now sensitive answers: stored encrypted, shown masked to you with a logged Reveal, and left out of exports and the API. On the signed copy the account number is printed as its last four digits only.",
          "The template file, its layout and its wording do not change, and neither do documents you have already sent.",
        ],
        ms: [
          "Negeri, negara, bank, jenis ID syarikat, fasa e-Invois dan jenis cukai kini mengambil pilihannya daripada senarai kongsi anda (Tetapan > Doc Sign > Senarai), jadi sebuah bank atau negeri ditukar sekali sahaja untuk semua borang.",
          "Kod MSIC perniagaan dipilih daripada senarai MSIC penuh dengan kotak carian dan tidak lagi ditaip.",
          "Nombor akaun bank dan nombor pendaftaran perniagaan kini jawapan sensitif: disimpan dengan penyulitan, dipaparkan bertopeng kepada anda dengan Tunjuk yang direkodkan, dan tidak disertakan dalam eksport dan API. Pada salinan bertandatangan, nombor akaun dicetak sebagai empat digit terakhir sahaja.",
          "Fail templat, susun atur dan perkataannya tidak berubah, begitu juga dokumen yang telah anda hantar.",
        ],
        zh: [
          "州属、国家、银行、公司证件类型、电子发票阶段和税种现在使用您的共享列表（设置 > Doc Sign > 列表）中的选项，因此修改一家银行或一个州属，所有表单都会同步更新。",
          "企业 MSIC 代码改为在完整的 MSIC 列表中搜索选择，不再手动输入。",
          "银行账号和商业注册号现在是敏感答案：加密存储，对您以掩码显示（查看完整内容会被记录），不包含在导出和 API 中。签署副本上的账号只印出最后四位数字。",
          "模板文件、版式和措辞均不变，您已发送的文件也不受影响。",
        ],
        ko: [
          "주, 국가, 은행, 회사 ID 유형, 전자세금계산서 단계, 세금 유형의 선택지가 이제 공유 목록(설정 > Doc Sign > 목록)에서 오므로, 은행이나 주를 한 번만 바꾸면 모든 양식에 반영됩니다.",
          "사업 MSIC 코드는 직접 입력하는 대신 검색창이 있는 전체 MSIC 목록에서 고릅니다.",
          "은행 계좌번호와 사업자 등록번호는 이제 민감한 답변입니다. 암호화하여 저장하고, 마스킹하여 보여 주며(전체 보기는 기록됨), 내보내기와 API에서는 제외됩니다. 서명본에는 계좌번호가 마지막 네 자리만 인쇄됩니다.",
          "템플릿 파일, 레이아웃, 문구는 바뀌지 않으며 이미 보낸 문서도 바뀌지 않습니다.",
        ],
      },
    },
  ],
  // the templates exactly as 1.1 shipped them (the form with every option typed in): a template that still equals this has not been edited
  history: [
    {
      version: "1.1",
      templates: [{ name: "Merchant Application", roles: MERCHANT_ROLES, fields: MERCHANT_PLACEMENTS, form: MERCHANT_FORM_V1, defaults: { ...MERCHANT_DEFAULTS, reminder_days: [...MERCHANT_DEFAULTS.reminder_days] } }],
    },
  ],
};
