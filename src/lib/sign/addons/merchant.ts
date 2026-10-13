// ============================================================
// Merchant Registration (add-on `merchant`), version 3.0.
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
// Nothing here is a legal text. Part 5 is two boxes of text the sender writes (the platform fee, and up to 15 numbered key terms), each
// starting with neutral placeholder points (./merchant/default-terms.ts: the owner's agreed default points go there); different groups of
// merchants are different templates (duplicate the template). The signing consent stays the workspace's own or the product default until
// the owner has the wording reviewed.
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
//   3.0  Part 5 (commercial terms) is two boxes of text instead of thirteen, on a new template FILE. Because the file changed, no installed
//        template can be given the new layout as a new version of itself (a version keeps its file): an Update adds the new template as a
//        draft "Merchant Application (updated)" beside the current one, and leaves the current one, and every document and draft made from
//        it, exactly as they are. The placements of 1.1 and 2.0 are frozen in ./merchant/history/placements-v2.json.
// ============================================================

import type { PlacedField } from "../pdf/types";
import type { AddonManifest } from "./index";
import { MERCHANT_FORM, MERCHANT_FORM_V1, MERCHANT_FORM_V2, MERCHANT_ROLES } from "./merchant/form";
import { MERCHANT_PLACEMENTS } from "./merchant/layout";
import placementsV2 from "./merchant/history/placements-v2.json";

/** The placed fields of versions 1.1 and 2.0 (nine key-term boxes and four fee boxes in Part 5), as shipped: never edited. */
export const MERCHANT_PLACEMENTS_V2 = placementsV2 as unknown as PlacedField[];

const MERCHANT_DEFAULTS = { code_required: false, sign_in_order: false, locale: "en", expiry_days: 30, reminder_days: [3, 7] } as const;

/** The template file, relative to src/lib/sign/addons/merchant/. */
export const MERCHANT_TEMPLATE_SOURCE = "assets/merchant-application.pdf";

export const merchantAddon: AddonManifest = {
  key: "merchant",
  // 3.0: Part 5 is two boxes of text on a new template file. 2.0: shared option lists and sensitive answers. 1.1 added the Merchant Application template and its form (1.0 only had the category)
  version: "3.0",
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
      version: "3.0",
      items: {
        en: [
          "Part 5 (Commercial terms) is now just two boxes: Platform fee, and Key terms, which holds up to 15 numbered points. The thirteen separate boxes are gone. Each box starts with neutral placeholder lines that you replace with your agreed fees and wording.",
          "Text that does not fit its box is never cut off in the signed copy: saving the template warns you, and sending a document is refused with a clear message until the text is shortened.",
          "The words beside the “I have read and accept” tick no longer list the nine old headings; the signer reads Part 5.",
          "Business details: the types of business are now Sole proprietor, Partnership, Sdn. Bhd., Club, society or co-operative and Others (Bhd. is gone). A club, society or co-operative uploads its latest minutes of meeting. A sole proprietor or partnership gives up to 5 Business codes; the others give MSIC codes. The Registration ID type and the Business activity are no longer asked. SST is a Yes or No question, and only for Yes the type of tax (Service tax or Sales tax), the percentage (6, 8 or 10) and the SST registration number are asked.",
          "Contacts: Person in charge (name, email, phone), Operations responsible (name, email), Finance responsible (name, email) and one E-invoice and payment receipt email, all required. The contact person's designation, the e-invoice person in charge and the separate e-invoice email are gone.",
          "Because the template file itself changed, Update adds a new draft template named “Merchant Application (updated)” beside your current one. Your current template, and every document and draft made from it, stay exactly as they are: switch over when you like.",
        ],
        ms: [
          "Bahagian 5 (Terma komersial) kini hanya dua kotak: Yuran platform, dan Terma utama yang memuatkan sehingga 15 perkara bernombor. Tiga belas kotak berasingan telah dibuang. Setiap kotak bermula dengan baris pemegang tempat yang neutral untuk anda gantikan dengan yuran dan perkataan yang dipersetujui.",
          "Teks yang tidak muat dalam kotaknya tidak pernah dipotong dalam salinan bertandatangan: menyimpan templat memberi amaran, dan penghantaran dokumen ditolak dengan mesej yang jelas sehingga teks dipendekkan.",
          "Perkataan di sebelah tanda “Saya telah membaca dan menerima” tidak lagi menyenaraikan sembilan tajuk lama; penandatangan membaca Bahagian 5.",
          "Butiran perniagaan: jenis perniagaan kini Pemilik tunggal, Perkongsian, Sdn. Bhd., Kelab, persatuan atau koperasi dan Lain-lain (Bhd. dibuang). Kelab, persatuan atau koperasi memuat naik minit mesyuarat terkini. Pemilik tunggal atau perkongsian memberikan sehingga 5 Kod perniagaan; yang lain memberikan kod MSIC. Jenis ID pendaftaran dan Aktiviti perniagaan tidak lagi ditanya. SST ialah soalan Ya atau Tidak, dan hanya untuk Ya ditanya jenis cukai (Cukai perkhidmatan atau Cukai jualan), peratusan (6, 8 atau 10) dan nombor pendaftaran SST.",
          "Hubungan: Orang yang bertanggungjawab (nama, e-mel, telefon), Orang bertanggungjawab operasi (nama, e-mel), Orang bertanggungjawab kewangan (nama, e-mel) dan satu E-mel e-Invois dan resit pembayaran, semuanya wajib. Jawatan orang yang dihubungi, orang bertanggungjawab e-Invois dan e-mel e-Invois yang berasingan dibuang.",
          "Kerana fail templat itu sendiri berubah, Kemas kini menambah templat draf baharu bernama “Merchant Application (updated)” di sebelah templat semasa anda. Templat semasa anda, dan setiap dokumen serta draf yang dibuat daripadanya, kekal seperti sedia ada: beralihlah apabila anda mahu.",
        ],
        zh: [
          "第5部分（商业条款）现在只有两个框：平台费用，以及最多可容纳 15 条编号条款的主要条款。原来的十三个独立框已取消。每个框以中性的占位文字开头，请替换为您约定的费用和条款文字。",
          "放不下的文字绝不会在签署副本中被截断：保存模板时会提醒您，发送文件时会被拒绝并给出明确提示，直到文字缩短为止。",
          "“我已阅读并接受”勾选框旁的文字不再列出九个旧标题；签署人直接阅读第5部分。",
          "企业资料：企业类型现为独资经营、合伙经营、Sdn. Bhd.、俱乐部、社团或合作社，以及其他（Bhd. 已取消）。俱乐部、社团或合作社须上传最新会议记录。独资经营或合伙经营填写最多 5 个业务代码，其他类型填写 MSIC 代码。不再询问注册证件类型和业务活动。SST 改为“是”或“否”的问题，只有选“是”才需填写税种（服务税或销售税）、税率（6、8 或 10）和 SST 注册号。",
          "联系人：负责人（姓名、邮箱、电话）、运营负责人（姓名、邮箱）、财务负责人（姓名、邮箱）以及一个电子发票及付款收据邮箱，均为必填。原来的联系人职务、电子发票负责人和单独的电子发票邮箱已取消。",
          "由于模板文件本身已更改，更新会在您当前的模板旁新增一份名为“Merchant Application (updated)”的草稿模板。您当前的模板，以及由它创建的所有文件和草稿，都保持原样；您可以随时切换。",
        ],
        ko: [
          "5부(상업 약관)는 이제 두 개의 칸뿐입니다. 플랫폼 수수료, 그리고 번호가 매겨진 항목을 최대 15개까지 담는 주요 약관입니다. 따로 있던 열세 개의 칸은 없어졌습니다. 각 칸은 중립적인 안내 문구로 시작하며, 합의한 수수료와 문구로 바꿔 쓰시면 됩니다.",
          "칸에 들어가지 않는 글은 서명본에서 잘리지 않습니다. 템플릿을 저장할 때 알려 드리고, 문서를 보낼 때는 글을 줄일 때까지 명확한 안내와 함께 발송이 거부됩니다.",
          "“읽었으며 동의합니다” 체크 옆의 문구는 더 이상 예전 아홉 개 제목을 나열하지 않습니다. 서명자는 5부를 읽습니다.",
          "사업체 정보: 사업 유형은 이제 개인사업자, 파트너십, Sdn. Bhd., 클럽·협회·협동조합, 기타입니다(Bhd.는 없어졌습니다). 클럽·협회·협동조합은 최근 회의록을 업로드합니다. 개인사업자와 파트너십은 사업 코드를 최대 5개, 나머지는 MSIC 코드를 입력합니다. 등록 번호 유형과 사업 활동은 더 이상 묻지 않습니다. SST는 예/아니요로 묻고, 예일 때만 세금 유형(서비스세 또는 판매세), 세율(6, 8, 10), SST 등록번호를 묻습니다.",
          "연락처: 담당자(이름, 이메일, 연락처), 운영 담당자(이름, 이메일), 재무 담당자(이름, 이메일), 그리고 전자세금계산서 및 결제 영수증 이메일 하나가 모두 필수입니다. 이전의 담당자 직책, 전자세금계산서 담당자, 별도의 전자세금계산서 이메일은 없어졌습니다.",
          "템플릿 파일 자체가 바뀌었으므로, 업데이트하면 현재 템플릿 옆에 “Merchant Application (updated)”라는 새 초안 템플릿이 추가됩니다. 현재 템플릿과 그것으로 만든 모든 문서와 초안은 그대로 유지되며, 원하실 때 바꿔 쓰시면 됩니다.",
        ],
      },
    },
    {
      version: "2.0",
      items: {
        en: [
          "State, country, bank, company ID type, e-invoice phase and tax type now take their choices from your shared lists (Settings > Secure Sign > Lists), so a bank or a state is changed once for every form.",
          "Business MSIC codes are picked from the full MSIC list with a search box instead of being typed in.",
          "The bank account number and the business registration number are now sensitive answers: stored encrypted, shown masked to you with a logged Reveal, and left out of exports and the API. On the signed copy the account number is printed as its last four digits only.",
          "The template file, its layout and its wording do not change, and neither do documents you have already sent.",
        ],
        ms: [
          "Negeri, negara, bank, jenis ID syarikat, fasa e-Invois dan jenis cukai kini mengambil pilihannya daripada senarai kongsi anda (Tetapan > Secure Sign > Senarai), jadi sebuah bank atau negeri ditukar sekali sahaja untuk semua borang.",
          "Kod MSIC perniagaan dipilih daripada senarai MSIC penuh dengan kotak carian dan tidak lagi ditaip.",
          "Nombor akaun bank dan nombor pendaftaran perniagaan kini jawapan sensitif: disimpan dengan penyulitan, dipaparkan bertopeng kepada anda dengan Tunjuk yang direkodkan, dan tidak disertakan dalam eksport dan API. Pada salinan bertandatangan, nombor akaun dicetak sebagai empat digit terakhir sahaja.",
          "Fail templat, susun atur dan perkataannya tidak berubah, begitu juga dokumen yang telah anda hantar.",
        ],
        zh: [
          "州属、国家、银行、公司证件类型、电子发票阶段和税种现在使用您的共享列表（设置 > Secure Sign > 列表）中的选项，因此修改一家银行或一个州属，所有表单都会同步更新。",
          "企业 MSIC 代码改为在完整的 MSIC 列表中搜索选择，不再手动输入。",
          "银行账号和商业注册号现在是敏感答案：加密存储，对您以掩码显示（查看完整内容会被记录），不包含在导出和 API 中。签署副本上的账号只印出最后四位数字。",
          "模板文件、版式和措辞均不变，您已发送的文件也不受影响。",
        ],
        ko: [
          "주, 국가, 은행, 회사 ID 유형, 전자세금계산서 단계, 세금 유형의 선택지가 이제 공유 목록(설정 > Secure Sign > 목록)에서 오므로, 은행이나 주를 한 번만 바꾸면 모든 양식에 반영됩니다.",
          "사업 MSIC 코드는 직접 입력하는 대신 검색창이 있는 전체 MSIC 목록에서 고릅니다.",
          "은행 계좌번호와 사업자 등록번호는 이제 민감한 답변입니다. 암호화하여 저장하고, 마스킹하여 보여 주며(전체 보기는 기록됨), 내보내기와 API에서는 제외됩니다. 서명본에는 계좌번호가 마지막 네 자리만 인쇄됩니다.",
          "템플릿 파일, 레이아웃, 문구는 바뀌지 않으며 이미 보낸 문서도 바뀌지 않습니다.",
        ],
      },
    },
  ],
  // the templates exactly as 1.1 and 2.0 shipped them (1.1: the form with every option typed in; 2.0: shared lists and sensitive answers; both with the
  // nine-box Part 5 and so the old template file). A template that still equals one of these has not been edited. Since 3.0 ships a different file, an
  // update never matches one in place (update.ts compares the file first): it adds the new template beside the old, which stays as it is.
  history: [
    {
      version: "1.1",
      templates: [{ name: "Merchant Application", roles: MERCHANT_ROLES, fields: MERCHANT_PLACEMENTS_V2, form: MERCHANT_FORM_V1, defaults: { ...MERCHANT_DEFAULTS, reminder_days: [...MERCHANT_DEFAULTS.reminder_days] } }],
    },
    {
      version: "2.0",
      templates: [{ name: "Merchant Application", roles: MERCHANT_ROLES, fields: MERCHANT_PLACEMENTS_V2, form: MERCHANT_FORM_V2, defaults: { ...MERCHANT_DEFAULTS, reminder_days: [...MERCHANT_DEFAULTS.reminder_days] } }],
    },
  ],
};
