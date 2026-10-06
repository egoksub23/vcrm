// ============================================================
// Merchant Application: the roles and the form (docs/vircle-sign-features.md, Appendix A, parts 1 to 6).
//
// Pure data, shared with the layout of the template file (layout.ts prints the labels from here, so a
// label is written once). Nothing in this file is a legal text: the commercial terms are headings with
// wording the owner supplies (see layout.ts and the report that came with it).
//
// Roles
//   merchant   a signer. Holds every part (1 to 6) and signs.
//   finance    an OPTIONAL filler (completes, does not sign). It holds nothing by default. To let a finance
//              person fill the bank part, give the part "bank" to this role: in the form builder, open the
//              part "Bank account" and choose the role "Finance contact", or build the form with
//              `merchantForm({ bankRole: "finance" })`. The sender then names a person for that role when
//              sending. Switching leaves every other part with the merchant.
//   director   a signer who countersigns. Holds no part, only the countersignature placements on the last page.
//
// Option lists the owner has not supplied yet (BRN types, e-invoice phases, tax types, banks, countries)
// are sensible Malaysian values marked "to confirm" in the report. Values are stable keys; change a label
// freely, never a value that answers already use.
//
// Two generations of the form (add-on version 1.1 and 2.0, see ../merchant.ts)
//   1  every option typed in below, nothing marked sensitive: what version 1.1 installed. It is kept (MERCHANT_FORM_V1) because the
//      template file is DRAWN from it (the tick boxes need the options, so the PDF does not change) and because an update must
//      recognise a template that still equals it.
//   2  (the default, MERCHANT_FORM) the choices take their options from the workspace's shared lists (Settings > Doc Sign > Lists:
//      states, countries, banks, company ID types, e-invoice phases, tax types, MSIC), so an admin who relabels or adds a bank
//      changes it once; and the answers that identify a person or an account are sensitive (encrypted, masked on the sender's screen,
//      left out of exports and the API, never written to the contact): see SENSITIVE_FIELDS for which and why.
//
// What the shared module cannot say per field (a custom validation message) is worded once per error code
// by the signing page; the help texts below tell the person the shape that is expected.
// ============================================================

import type { SignRole } from "../../types";
import type { DataField, FieldOption, FormDefinition, FormPart, L10n, Rule } from "../../forms/types";

type Lang = Exclude<keyof L10n, "en">;

/** English, Bahasa Melayu, then Chinese and Korean where the wording is confident. */
const L = (en: string, ms: string, zh?: string, ko?: string): L10n => ({ en, ms, ...(zh ? { zh } : {}), ...(ko ? { ko } : {}) });
const opt = (value: string, label: L10n): FieldOption => ({ value, label });
/** An option whose name is the same in every language (a proper noun). */
const same = (value: string, name: string): FieldOption => opt(value, { en: name });

export const MERCHANT_ROLE = "merchant";
export const FINANCE_ROLE = "finance";
export const DIRECTOR_ROLE = "director";

export const MERCHANT_ROLES: SignRole[] = [
  { key: MERCHANT_ROLE, label: "Merchant", kind: "signer", color: 0 },
  { key: FINANCE_ROLE, label: "Finance contact", kind: "filler", color: 1 },
  { key: DIRECTOR_ROLE, label: "Director (countersign)", kind: "signer", color: 2 },
];

// ---- the option lists (to confirm) ---------------------------------------------------------------------------------

export const BUSINESS_TYPES: FieldOption[] = [
  opt("sole_prop", L("Sole proprietor", "Pemilik tunggal", "独资经营", "개인사업자")),
  opt("partnership", L("Partnership", "Perkongsian", "合伙经营", "파트너십")),
  opt("sdn_bhd", L("Sdn. Bhd.", "Sdn. Bhd.")),
  opt("bhd", L("Bhd.", "Bhd.")),
  opt("other", L("Others", "Lain-lain", "其他", "기타")),
];

/** Business registration number types. To confirm. */
export const BRN_TYPES: FieldOption[] = [
  opt("nric", L("NRIC", "NRIC", "身份证 (NRIC)", "신분증 (NRIC)")),
  opt("roc", L("ROC (company registration no.)", "ROC (no. pendaftaran syarikat)", "ROC（公司注册号）", "ROC (회사 등록번호)")),
  opt("brn", L("BRN (business registration no.)", "BRN (no. pendaftaran perniagaan)", "BRN（商业注册号）", "BRN (사업자 등록번호)")),
  opt("passport", L("Passport", "Pasport", "护照", "여권")),
  opt("army_police", L("Army or police no.", "No. tentera atau polis", "军人或警察编号", "군인·경찰 번호")),
];

/**
 * When the business must start e-invoicing, by annual turnover. The thresholds are written as the published
 * LHDN timeline states them at the time of writing (no dates, which have moved): TO CONFIRM before use.
 */
export const EINVOICE_PHASES: FieldOption[] = [
  opt("phase_1", L("Phase 1: above RM100 million", "Fasa 1: melebihi RM100 juta", "第一阶段：超过1亿令吉", "1단계: 1억 링깃 초과")),
  opt("phase_2", L("Phase 2: above RM25 million to RM100 million", "Fasa 2: melebihi RM25 juta hingga RM100 juta", "第二阶段：超过2500万至1亿令吉", "2단계: 2,500만 링깃 초과 ~ 1억 링깃")),
  opt("phase_3", L("Phase 3: above RM5 million to RM25 million", "Fasa 3: melebihi RM5 juta hingga RM25 juta", "第三阶段：超过500万至2500万令吉", "3단계: 500만 링깃 초과 ~ 2,500만 링깃")),
  opt("phase_4", L("Phase 4: above RM1 million to RM5 million", "Fasa 4: melebihi RM1 juta hingga RM5 juta", "第四阶段：超过100万至500万令吉", "4단계: 100만 링깃 초과 ~ 500만 링깃")),
  opt("not_required", L("Not required: RM1 million or less", "Tidak diwajibkan: RM1 juta atau kurang", "无需：100万令吉或以下", "해당 없음: 100만 링깃 이하")),
];

/** Tax types. To confirm. */
export const TAX_TYPES: FieldOption[] = [
  opt("sst", L("SST (Sales and Service Tax)", "SST (Cukai Jualan dan Perkhidmatan)", "SST（销售与服务税）", "SST (판매 및 서비스세)")),
  opt("na", L("Not applicable", "Tidak berkenaan", "不适用", "해당 없음")),
];

/** The 13 states and 3 federal territories. */
export const MALAYSIAN_STATES: FieldOption[] = [
  opt("johor", L("Johor", "Johor", "柔佛", "조호르")),
  opt("kedah", L("Kedah", "Kedah", "吉打", "케다")),
  opt("kelantan", L("Kelantan", "Kelantan", "吉兰丹", "클란탄")),
  opt("melaka", L("Melaka", "Melaka", "马六甲", "믈라카")),
  opt("negeri_sembilan", L("Negeri Sembilan", "Negeri Sembilan", "森美兰", "느그리슴빌란")),
  opt("pahang", L("Pahang", "Pahang", "彭亨", "파항")),
  opt("perak", L("Perak", "Perak", "霹雳", "페락")),
  opt("perlis", L("Perlis", "Perlis", "玻璃市", "페를리스")),
  opt("pulau_pinang", L("Pulau Pinang", "Pulau Pinang", "槟城", "페낭")),
  opt("sabah", L("Sabah", "Sabah", "沙巴", "사바")),
  opt("sarawak", L("Sarawak", "Sarawak", "砂拉越", "사라왁")),
  opt("selangor", L("Selangor", "Selangor", "雪兰莪", "슬랑오르")),
  opt("terengganu", L("Terengganu", "Terengganu", "登嘉楼", "트렝가누")),
  opt("wp_kuala_lumpur", L("W.P. Kuala Lumpur", "W.P. Kuala Lumpur", "吉隆坡联邦直辖区", "쿠알라룸푸르 연방직할지")),
  opt("wp_putrajaya", L("W.P. Putrajaya", "W.P. Putrajaya", "布城联邦直辖区", "푸트라자야 연방직할지")),
  opt("wp_labuan", L("W.P. Labuan", "W.P. Labuan", "纳闽联邦直辖区", "라부안 연방직할지")),
];

/** Countries: Malaysia first. A short list to confirm; the owner may extend it. */
export const COUNTRIES: FieldOption[] = [
  opt("MY", L("Malaysia", "Malaysia", "马来西亚", "말레이시아")),
  opt("SG", L("Singapore", "Singapura", "新加坡", "싱가포르")),
  opt("BN", L("Brunei", "Brunei", "文莱", "브루나이")),
  opt("ID", L("Indonesia", "Indonesia", "印度尼西亚", "인도네시아")),
  opt("TH", L("Thailand", "Thailand", "泰国", "태국")),
  opt("PH", L("Philippines", "Filipina", "菲律宾", "필리핀")),
  opt("VN", L("Vietnam", "Vietnam", "越南", "베트남")),
  opt("CN", L("China", "China", "中国", "중국")),
  opt("HK", L("Hong Kong", "Hong Kong", "中国香港", "홍콩")),
  opt("TW", L("Taiwan", "Taiwan", "中国台湾", "대만")),
  opt("JP", L("Japan", "Jepun", "日本", "일본")),
  opt("KR", L("South Korea", "Korea Selatan", "韩国", "대한민국")),
  opt("IN", L("India", "India", "印度", "인도")),
  opt("AU", L("Australia", "Australia", "澳大利亚", "호주")),
  opt("GB", L("United Kingdom", "United Kingdom", "英国", "영국")),
  opt("US", L("United States", "Amerika Syarikat", "美国", "미국")),
];

/** The main banks in Malaysia, with "Other" for the rest. To confirm. */
export const BANKS: FieldOption[] = [
  same("maybank", "Maybank"),
  same("cimb", "CIMB Bank"),
  same("public_bank", "Public Bank"),
  same("rhb", "RHB Bank"),
  same("hong_leong", "Hong Leong Bank"),
  same("ambank", "AmBank"),
  same("bank_islam", "Bank Islam"),
  same("bank_rakyat", "Bank Rakyat"),
  same("bsn", "Bank Simpanan Nasional (BSN)"),
  same("affin", "Affin Bank"),
  same("alliance", "Alliance Bank"),
  same("ocbc", "OCBC Bank"),
  same("uob", "UOB"),
  same("hsbc", "HSBC Bank"),
  same("standard_chartered", "Standard Chartered"),
  same("mbsb", "MBSB Bank"),
  same("bank_muamalat", "Bank Muamalat"),
  same("agrobank", "Agrobank"),
  same("citibank", "Citibank"),
  opt("other", L("Other", "Lain-lain", "其他", "기타")),
];

// ---- parts ------------------------------------------------------------------------------------------------------------

export interface MerchantFormOptions {
  /** Who completes the bank part. Default the merchant; "finance" hands it to the optional finance filler. */
  bankRole?: typeof MERCHANT_ROLE | typeof FINANCE_ROLE;
  /** 1: the form of add-on 1.1 (options typed in). 2 (default): shared option lists and sensitive answers. */
  generation?: 1 | 2;
}

export const PART = {
  company: "company",
  contacts: "contacts",
  bank: "bank",
  documents: "documents",
  terms: "terms",
  signing: "signing",
} as const;

/** The nine key terms, as headings only. The wording under each is the owner's to supply. */
export const TERM_HEADINGS: { key: string; title: L10n }[] = [
  { key: "partner", title: L("Partner", "Rakan kongsi", "合作伙伴", "파트너") },
  { key: "decline", title: L("Right to decline", "Hak menolak", "拒绝权", "거절할 권리") },
  { key: "information", title: L("Information requests", "Permintaan maklumat", "信息请求", "정보 요청") },
  { key: "access", title: L("Account access", "Akses akaun", "账户访问", "계정 접근") },
  { key: "refund", title: L("Refund and void", "Bayaran balik dan pembatalan", "退款与作废", "환불 및 취소") },
  { key: "termination", title: L("Termination: 60 days' notice", "Penamatan: notis 60 hari", "终止：提前60天通知", "해지: 60일 전 통지") },
  { key: "binding", title: L("Binding effect of the merchant terms", "Kesan mengikat terma peniaga", "商户条款的约束力", "가맹점 약관의 구속력") },
  { key: "hardware", title: L("Hardware", "Perkakasan", "硬件", "하드웨어") },
  { key: "settlement", title: L("Settlement: twice weekly", "Penyelesaian: dua kali seminggu", "结算：每周两次", "정산: 주 2회") },
];

function acknowledgeText(): L10n {
  const list = (lang: Lang | "en") => TERM_HEADINGS.map((t) => `- ${t.title[lang] ?? t.title.en}`).join("\n");
  return {
    en: `The fees and the key terms are printed in Part 5 of the document. You can read them on the Review and sign step.\n\nThe key terms are:\n${list("en")}\n\nBy ticking, you confirm that you have read and accept the fees and the key terms.`,
    ms: `Yuran dan terma utama dicetak dalam Bahagian 5 dokumen. Anda boleh membacanya pada langkah Semak dan tandatangan.\n\nTerma utama ialah:\n${list("ms")}\n\nDengan menanda, anda mengesahkan bahawa anda telah membaca dan menerima yuran dan terma utama.`,
    zh: `费用和主要条款印在文件的第5部分，您可以在“核对并签署”步骤中阅读。\n\n主要条款包括：\n${list("zh")}\n\n勾选即表示您确认已阅读并接受这些费用和主要条款。`,
    ko: `수수료와 주요 약관은 문서의 5부에 인쇄되어 있으며, "검토 및 서명" 단계에서 읽을 수 있습니다.\n\n주요 약관은 다음과 같습니다.\n${list("ko")}\n\n체크하시면 수수료와 주요 약관을 읽고 동의하신 것으로 확인합니다.`,
  };
}

function parts(opts: MerchantFormOptions): FormPart[] {
  const bankRole = opts.bankRole ?? MERCHANT_ROLE;
  return [
    {
      key: PART.company,
      role: MERCHANT_ROLE,
      title: L("Company and tax", "Syarikat dan cukai", "公司与税务", "회사 및 세금"),
      description: L("Who the business is, how it is registered, and its tax and e-invoice details.", "Siapa perniagaan ini, cara ia didaftarkan, serta butiran cukai dan e-Invois.", "企业的基本信息、注册方式，以及税务和电子发票资料。", "사업체 정보, 등록 방식, 세금 및 전자세금계산서 정보입니다."),
    },
    {
      key: PART.contacts,
      role: MERCHANT_ROLE,
      title: L("Address and contacts", "Alamat dan hubungan", "地址与联系人", "주소 및 연락처"),
      description: L("Where the business is, and who we can reach.", "Lokasi perniagaan dan orang yang boleh kami hubungi.", "企业所在地以及我们可以联系的人。", "사업장 위치와 연락할 수 있는 담당자입니다."),
    },
    {
      key: PART.bank,
      role: bankRole,
      title: L("Bank account", "Akaun bank", "银行账户", "은행 계좌"),
      description: L("The account where payouts are paid.", "Akaun tempat bayaran dibuat.", "用于收款结算的账户。", "정산금을 받는 계좌입니다."),
    },
    {
      key: PART.documents,
      role: MERCHANT_ROLE,
      title: L("Documents", "Dokumen", "文件", "서류"),
      description: L("Upload the documents for your type of business.", "Muat naik dokumen untuk jenis perniagaan anda.", "请上传与您的企业类型相符的文件。", "사업 유형에 맞는 서류를 업로드하세요."),
    },
    {
      key: PART.terms,
      role: MERCHANT_ROLE,
      title: L("Commercial terms", "Terma komersial", "商业条款", "상업 약관"),
      description: L("Read the fees and the key terms, then confirm.", "Baca yuran dan terma utama, kemudian sahkan.", "请阅读费用和主要条款，然后确认。", "수수료와 주요 약관을 읽고 확인하세요."),
    },
    {
      key: PART.signing,
      role: MERCHANT_ROLE,
      title: L("Review and sign", "Semak dan tandatangan", "核对并签署", "검토 및 서명"),
      description: L("Your title, and the company stamp if you have one. Then you review the document and sign.", "Jawatan anda dan cop syarikat jika ada. Kemudian anda menyemak dokumen dan menandatangani.", "您的职务，以及公司印章（如有）。随后核对文件并签署。", "직책과 회사 직인(있는 경우)을 입력한 뒤 문서를 검토하고 서명합니다."),
    },
  ];
}

// ---- data fields -------------------------------------------------------------------------------------------------------

const SDN_OR_BHD: Rule = { op: "in", field: "business_type", values: ["sdn_bhd", "bhd"] };
const SOLE_OR_PARTNERSHIP: Rule = { op: "in", field: "business_type", values: ["sole_prop", "partnership"] };
const IS_SST: Rule = { op: "eq", field: "tax_type", value: "sst" };

const FILE_HELP = L("PDF, JPG or PNG, up to 8 MB for each file.", "PDF, JPG atau PNG, sehingga 8 MB bagi setiap fail.", "PDF、JPG 或 PNG，每个文件最大 8 MB。", "PDF, JPG 또는 PNG, 파일당 최대 8MB.");
const DIGITS_HELP = L("Digits only, no spaces or hyphens.", "Digit sahaja, tanpa ruang atau sengkang.", "仅限数字，不含空格或连字符。", "숫자만 입력하세요(공백·하이픈 제외).");
const PHONE_HELP = L("Start with 0 or +60, for example 012 345 6789.", "Mulakan dengan 0 atau +60, contohnya 012 345 6789.", "以 0 或 +60 开头，例如 012 345 6789。", "0 또는 +60으로 시작하세요(예: 012 345 6789).");

function fields(): DataField[] {
  const f = (d: DataField): DataField => d;
  return [
    // ---- part 1: company and tax -----------------------------------------------------------------------------------
    f({
      key: "legal_name",
      type: "multiline",
      part: PART.company,
      required: true,
      maxLength: 160,
      contactField: "company",
      label: L("Company legal name (as per SSM)", "Nama sah syarikat (mengikut SSM)", "公司法定名称（以 SSM 为准）", "회사 법적 명칭 (SSM 기준)"),
      help: L("Exactly as on your SSM registration.", "Tepat seperti dalam pendaftaran SSM anda.", "须与 SSM 注册资料完全一致。", "SSM 등록 내용과 정확히 같게 입력하세요."),
    }),
    f({
      key: "trading_name",
      type: "text",
      part: PART.company,
      required: false,
      maxLength: 120,
      label: L("Trading name (if different)", "Nama perniagaan (jika berbeza)", "营业名称（如不同）", "상호 (다른 경우)"),
      help: L("Leave empty if it is the same as the legal name.", "Biarkan kosong jika sama dengan nama sah.", "如与法定名称相同，请留空。", "법적 명칭과 같으면 비워 두세요."),
    }),
    f({
      key: "business_type",
      type: "choice",
      part: PART.company,
      required: true,
      options: BUSINESS_TYPES,
      label: L("Type of business", "Jenis perniagaan", "企业类型", "사업 유형"),
      help: L("This decides which documents you upload.", "Ini menentukan dokumen yang perlu dimuat naik.", "这将决定您需要上传哪些文件。", "업로드할 서류가 이에 따라 달라집니다."),
    }),
    f({
      key: "business_type_other",
      type: "text",
      part: PART.company,
      required: false,
      requiredIf: { op: "eq", field: "business_type", value: "other" },
      visibleIf: { op: "eq", field: "business_type", value: "other" },
      maxLength: 60,
      label: L("Other type of business (specify)", "Jenis perniagaan lain (nyatakan)", "其他企业类型（请注明）", "기타 사업 유형 (직접 입력)"),
    }),
    f({
      key: "brn_type",
      type: "choice",
      part: PART.company,
      required: false,
      options: BRN_TYPES,
      label: L("Registration ID type", "Jenis ID pendaftaran", "注册证件类型", "등록 번호 유형"),
    }),
    f({
      key: "brn",
      type: "text",
      part: PART.company,
      required: true,
      format: "digits",
      maxLength: 20,
      label: L("Business registration no. (BRN)", "No. pendaftaran perniagaan (BRN)", "商业注册号 (BRN)", "사업자 등록번호 (BRN)"),
      help: L("Digits only, without hyphens.", "Digit sahaja, tanpa sengkang.", "仅限数字，不含连字符。", "숫자만 입력하세요(하이픈 제외)."),
    }),
    f({
      key: "einvoice_phase",
      type: "choice",
      part: PART.company,
      required: true,
      options: EINVOICE_PHASES,
      label: L("When must you comply with e-invoicing", "Bila anda perlu mematuhi e-Invois", "您须何时实施电子发票", "전자세금계산서 의무 시행 시기"),
      help: L("Choose by your business's yearly turnover.", "Pilih mengikut perolehan tahunan perniagaan anda.", "请按企业的年营业额选择。", "사업체의 연 매출액에 따라 선택하세요."),
    }),
    f({
      key: "tin",
      type: "text",
      part: PART.company,
      required: true,
      maxLength: 20,
      label: L("Tax identification no. (TIN)", "No. pengenalan cukai (TIN)", "税务识别号 (TIN)", "납세자 식별번호 (TIN)"),
      help: L("The number from LHDN (MyTax).", "Nombor daripada LHDN (MyTax).", "来自 LHDN (MyTax) 的号码。", "LHDN(MyTax)에서 받은 번호입니다."),
    }),
    f({
      key: "tax_type",
      type: "choice",
      part: PART.company,
      required: false,
      options: TAX_TYPES,
      label: L("Tax type", "Jenis cukai", "税种", "세금 유형"),
    }),
    f({
      key: "tax_percent",
      type: "number",
      part: PART.company,
      required: false,
      requiredIf: IS_SST,
      visibleIf: IS_SST,
      min: 0,
      max: 100,
      decimals: 2,
      label: L("Tax percentage (%)", "Peratusan cukai (%)", "税率（%）", "세율 (%)"),
    }),
    f({
      key: "sst_no",
      type: "text",
      part: PART.company,
      required: false,
      requiredIf: IS_SST,
      visibleIf: IS_SST,
      maxLength: 30,
      label: L("SST registration no.", "No. pendaftaran SST", "SST 注册号", "SST 등록번호"),
    }),
    f({
      key: "msic_codes",
      type: "list",
      part: PART.company,
      required: true,
      maxItems: 10,
      itemFormat: "digits",
      itemLength: 5,
      itemMinLength: 5,
      label: L("Business MSIC code(s)", "Kod MSIC perniagaan", "业务 MSIC 代码", "사업 MSIC 코드"),
      help: L("Add each 5-digit code on its own, up to 10.", "Tambah setiap kod 5 digit satu demi satu, sehingga 10.", "逐个添加5位数代码，最多10个。", "5자리 코드를 하나씩 추가하세요(최대 10개)."),
    }),
    f({
      key: "business_activity",
      type: "multiline",
      part: PART.company,
      required: false,
      maxLength: 200,
      label: L("Business activity (as per SSM)", "Aktiviti perniagaan (mengikut SSM)", "业务活动（以 SSM 为准）", "사업 활동 (SSM 기준)"),
    }),

    // ---- part 2: address and contacts ------------------------------------------------------------------------------
    f({
      key: "address",
      type: "multiline",
      part: PART.contacts,
      required: true,
      maxLength: 240,
      label: L("Company address", "Alamat syarikat", "公司地址", "회사 주소"),
      help: L("Without the city, state and postcode, which come next.", "Tanpa bandar, negeri dan poskod, yang diminta seterusnya.", "不含城市、州属和邮编，这些将在后面填写。", "도시, 주, 우편번호는 제외하고 입력하세요."),
    }),
    f({ key: "city", type: "text", part: PART.contacts, required: true, maxLength: 60, label: L("City", "Bandar", "城市", "도시") }),
    f({
      key: "postcode",
      type: "text",
      part: PART.contacts,
      required: true,
      format: "postcode_my",
      label: L("Postcode", "Poskod", "邮编", "우편번호"),
      help: L("5 digits.", "5 digit.", "5位数字。", "5자리 숫자."),
    }),
    f({ key: "state", type: "choice", part: PART.contacts, required: true, options: MALAYSIAN_STATES, label: L("State", "Negeri", "州属", "주") }),
    f({ key: "country", type: "choice", part: PART.contacts, required: true, options: COUNTRIES, defaultValue: "MY", label: L("Country", "Negara", "国家", "국가") }),
    f({
      key: "company_phone",
      type: "phone",
      part: PART.contacts,
      required: true,
      label: L("Company contact no.", "No. telefon syarikat", "公司联系电话", "회사 연락처"),
      help: PHONE_HELP,
    }),
    f({
      key: "contact_name",
      type: "text",
      part: PART.contacts,
      required: true,
      maxLength: 100,
      contactField: "name",
      label: L("Contact person: name", "Orang untuk dihubungi: nama", "联系人：姓名", "담당자: 이름"),
    }),
    f({
      key: "contact_designation",
      type: "text",
      part: PART.contacts,
      required: true,
      maxLength: 60,
      label: L("Contact person: designation", "Orang untuk dihubungi: jawatan", "联系人：职务", "담당자: 직책"),
    }),
    f({
      key: "contact_phone",
      type: "phone",
      part: PART.contacts,
      required: true,
      label: L("Contact person: contact no.", "Orang untuk dihubungi: no. telefon", "联系人：电话", "담당자: 연락처"),
      help: PHONE_HELP,
    }),
    f({
      key: "contact_email",
      type: "email",
      part: PART.contacts,
      required: true,
      contactField: "email",
      // the signer was invited at an address of their own: fill the contact's email only when it has none
      writeBack: "if_empty",
      label: L("Contact person: email", "Orang untuk dihubungi: e-mel", "联系人：电子邮件", "담당자: 이메일"),
    }),
    f({
      key: "einv_pic_name",
      type: "text",
      part: PART.contacts,
      required: true,
      maxLength: 100,
      label: L("e-Invoice person in charge: name", "Orang bertanggungjawab e-Invois: nama", "电子发票负责人：姓名", "전자세금계산서 담당자: 이름"),
    }),
    f({
      key: "einv_pic_email",
      type: "email",
      part: PART.contacts,
      required: false,
      label: L("e-Invoice person in charge: email (finance)", "Orang bertanggungjawab e-Invois: e-mel (kewangan)", "电子发票负责人：电子邮件（财务）", "전자세금계산서 담당자: 이메일 (재무)"),
      help: L("For questions about e-invoices. Optional.", "Untuk pertanyaan tentang e-Invois. Pilihan.", "用于电子发票相关查询，可不填。", "전자세금계산서 문의용입니다. 선택 사항입니다."),
    }),
    f({
      key: "einvoice_email",
      type: "email",
      part: PART.contacts,
      required: true,
      label: L("e-Invoice email", "E-mel e-Invois", "电子发票邮箱", "전자세금계산서 이메일"),
      help: L("All e-invoices are sent to this address.", "Semua e-Invois dihantar ke alamat ini.", "所有电子发票都将发送到此邮箱。", "모든 전자세금계산서가 이 주소로 발송됩니다."),
    }),

    // ---- part 3: bank account --------------------------------------------------------------------------------------
    f({ key: "bank_name", type: "choice", part: PART.bank, required: true, options: BANKS, label: L("Bank name", "Nama bank", "银行名称", "은행명") }),
    f({
      key: "bank_name_other",
      type: "text",
      part: PART.bank,
      required: false,
      requiredIf: { op: "eq", field: "bank_name", value: "other" },
      visibleIf: { op: "eq", field: "bank_name", value: "other" },
      maxLength: 80,
      label: L("Other bank (name it)", "Bank lain (nyatakan nama)", "其他银行（请注明）", "기타 은행 (이름 입력)"),
    }),
    f({
      key: "bank_account",
      type: "text",
      part: PART.bank,
      required: true,
      format: "digits",
      minLength: 5,
      maxLength: 20,
      label: L("Account no.", "No. akaun", "账号", "계좌번호"),
      help: DIGITS_HELP,
    }),
    f({
      key: "bank_holder",
      type: "text",
      part: PART.bank,
      required: true,
      maxLength: 120,
      label: L("Account holder name", "Nama pemegang akaun", "账户持有人姓名", "예금주명"),
      help: L("Should match the company legal name.", "Hendaklah sama dengan nama sah syarikat.", "应与公司法定名称一致。", "회사 법적 명칭과 일치해야 합니다."),
    }),
    f({ key: "bank_branch", type: "text", part: PART.bank, required: true, maxLength: 80, label: L("Bank branch", "Cawangan bank", "银行分行", "은행 지점") }),
    f({
      key: "bank_swift",
      type: "text",
      part: PART.bank,
      required: false,
      format: "upper_alnum",
      minLength: 8,
      maxLength: 11,
      label: L("Swift code (if any)", "Kod Swift (jika ada)", "SWIFT 代码（如有）", "SWIFT 코드 (있는 경우)"),
      help: L("8 or 11 capital letters and digits.", "8 atau 11 huruf besar dan digit.", "8位或11位大写字母和数字。", "대문자와 숫자 8자리 또는 11자리."),
    }),
    f({
      key: "finance_contact",
      type: "text",
      part: PART.bank,
      required: true,
      maxLength: 100,
      label: L("Finance contact person", "Orang untuk dihubungi (kewangan)", "财务联系人", "재무 담당자"),
    }),

    // ---- part 4: documents -----------------------------------------------------------------------------------------
    f({
      key: "doc_form9",
      type: "file",
      part: PART.documents,
      required: true,
      visibleIf: SDN_OR_BHD,
      accept: ["pdf", "jpg", "png"],
      maxMb: 8,
      maxFiles: 3,
      minFiles: 1,
      label: L("Form 9", "Borang 9", "表格 9 (Form 9)", "Form 9"),
      help: FILE_HELP,
    }),
    f({
      key: "doc_form49",
      type: "file",
      part: PART.documents,
      required: true,
      visibleIf: SDN_OR_BHD,
      accept: ["pdf", "jpg", "png"],
      maxMb: 8,
      maxFiles: 3,
      minFiles: 1,
      label: L("Form 49", "Borang 49", "表格 49 (Form 49)", "Form 49"),
      help: FILE_HELP,
    }),
    f({
      key: "doc_form_d",
      type: "file",
      part: PART.documents,
      required: true,
      visibleIf: SOLE_OR_PARTNERSHIP,
      accept: ["pdf", "jpg", "png"],
      maxMb: 8,
      maxFiles: 3,
      minFiles: 1,
      label: L("Form D", "Borang D", "表格 D (Form D)", "Form D"),
      help: FILE_HELP,
    }),
    f({
      key: "doc_registration_other",
      type: "file",
      part: PART.documents,
      required: false,
      visibleIf: { op: "eq", field: "business_type", value: "other" },
      accept: ["pdf", "jpg", "png"],
      maxMb: 8,
      maxFiles: 3,
      label: L("Registration document (for other types of business)", "Dokumen pendaftaran (untuk jenis perniagaan lain)", "注册文件（其他企业类型）", "등록 서류 (기타 사업 유형)"),
      help: FILE_HELP,
    }),
    f({
      key: "doc_bank_statement",
      type: "file",
      part: PART.documents,
      required: true,
      accept: ["pdf", "jpg", "png"],
      maxMb: 8,
      maxFiles: 2,
      minFiles: 1,
      label: L("Bank statement header", "Pengepala penyata bank", "银行对账单抬头页", "은행 거래내역서 첫 면"),
      help: L("The top of a bank statement that shows the account name and number. PDF, JPG or PNG, up to 8 MB.", "Bahagian atas penyata bank yang menunjukkan nama dan nombor akaun. PDF, JPG atau PNG, sehingga 8 MB.", "显示账户名称和账号的银行对账单首部。PDF、JPG 或 PNG，最大 8 MB。", "계좌 이름과 번호가 보이는 거래내역서 상단입니다. PDF, JPG 또는 PNG, 최대 8MB."),
    }),
    f({
      key: "doc_owner_id",
      type: "file",
      part: PART.documents,
      required: true,
      accept: ["pdf", "jpg", "png"],
      maxMb: 8,
      maxFiles: 4,
      minFiles: 1,
      label: L("Photocopy of director or owner ID", "Salinan kad pengenalan pengarah atau pemilik", "董事或业主身份证复印件", "이사 또는 소유주 신분증 사본"),
      help: FILE_HELP,
    }),
    f({
      key: "premise_pictures",
      type: "file",
      part: PART.documents,
      required: true,
      accept: ["jpg", "png"],
      maxMb: 8,
      maxFiles: 3,
      minFiles: 1,
      label: L("Pictures of the business premise", "Gambar premis perniagaan", "营业场所照片", "사업장 사진"),
      help: L("One to three pictures. JPG or PNG, up to 8 MB each.", "Satu hingga tiga gambar. JPG atau PNG, sehingga 8 MB setiap satu.", "1至3张照片。JPG 或 PNG，每张最大 8 MB。", "1~3장. JPG 또는 PNG, 장당 최대 8MB."),
    }),

    // ---- part 5: commercial terms ----------------------------------------------------------------------------------
    f({
      key: "terms_accepted",
      type: "acknowledge",
      part: PART.terms,
      required: true,
      text: acknowledgeText(),
      label: L("I have read and accept the fees and key terms", "Saya telah membaca dan menerima yuran dan terma utama", "我已阅读并接受费用和主要条款", "수수료와 주요 약관을 읽었으며 동의합니다"),
    }),

    // ---- part 6: review and sign -----------------------------------------------------------------------------------
    f({
      key: "signer_designation",
      type: "text",
      part: PART.signing,
      required: true,
      maxLength: 60,
      label: L("Designation of the person signing", "Jawatan penandatangan", "签署人职务", "서명자 직책"),
      help: L("For example Director. It is printed under your name.", "Contohnya Pengarah. Ia dicetak di bawah nama anda.", "例如：董事。将印在您的姓名下方。", "예: 이사. 이름 아래에 인쇄됩니다."),
    }),
    f({
      key: "company_stamp",
      type: "image",
      part: PART.signing,
      required: false,
      label: L("Official company stamp", "Cop rasmi syarikat", "公司公章", "회사 공식 직인"),
      help: L("A clear picture of the stamp, PNG or JPG. Optional.", "Gambar cop yang jelas, PNG atau JPG. Pilihan.", "清晰的印章图片，PNG 或 JPG。可不填。", "직인의 선명한 사진(PNG 또는 JPG). 선택 사항입니다."),
    }),
  ];
}

/** The choices that take their options from a shared list in generation 2, and which list. `business_type` stays typed in: it is this add-on's own five. */
export const LIST_FIELDS: Readonly<Record<string, string>> = {
  brn_type: "company_id_types",
  einvoice_phase: "einvoice_phases",
  tax_type: "tax_types",
  state: "states_my",
  country: "countries",
  bank_name: "banks_my",
  msic_codes: "msic",
};

/**
 * The answers generation 2 marks sensitive (encrypted at rest, shown masked to the sender with a logged "Reveal", never in an export
 * or the API, never copied to the contact), and how each is printed on the sealed PDF. DECIDED, to confirm with the owner:
 *   bank_account  sensitive; printed as the last four digits only. A payout account number is the one answer here that lets someone
 *                 move money, and the sealed agreement is emailed to every signer.
 *   brn           sensitive; printed in full. It is a company's registration number (public on the SSM register) but, when the type is
 *                 NRIC or passport, a person's identity number, and the form cannot tell which. The signed agreement has to name the
 *                 contracting party, so it is not masked there. Turn the switch off in the template editor for a workspace that only
 *                 signs up companies.
 *   tin           NOT sensitive. The tax identification number is shared on every e-invoice by design, and staff need it in full to
 *                 set the merchant up for e-invoicing.
 * There is no separate identity-card or passport field in this form (the director's ID is an uploaded file, which a file cannot mask).
 */
export const SENSITIVE_FIELDS: Readonly<Record<string, Pick<DataField, "printMasked">>> = {
  bank_account: { printMasked: "last4" },
  brn: {},
};

/** Generation 2 of the data fields: the list-bound choices drop their typed-in options, the sensitive ones are flagged. */
function generation2(list: DataField[]): DataField[] {
  return list.map((f) => {
    let out = f;
    const key = LIST_FIELDS[f.key];
    if (key) {
      const { options: _typedIn, ...rest } = f;
      void _typedIn;
      out = { ...rest, optionList: key };
    }
    const sensitive = SENSITIVE_FIELDS[f.key];
    if (sensitive) out = { ...out, sensitive: true, ...sensitive };
    return out;
  });
}

/** The Merchant Application form. Pass `{ bankRole: "finance" }` to give the bank part to the finance filler, `{ generation: 1 }` for the form of add-on 1.1. */
export function merchantForm(opts: MerchantFormOptions = {}): FormDefinition {
  const base = fields();
  return { version: 1, parts: parts(opts), fields: opts.generation === 1 ? base : generation2(base) };
}

/** The default form: the merchant fills every part. */
export const MERCHANT_FORM: FormDefinition = merchantForm();

/** The form of add-on version 1.1 (options typed in, nothing sensitive): the template file is drawn from it, and an update recognises it. */
export const MERCHANT_FORM_V1: FormDefinition = merchantForm({ generation: 1 });
