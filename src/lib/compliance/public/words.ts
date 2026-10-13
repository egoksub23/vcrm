// ============================================================
// Compliance requests, the public parent forms: the words of the page, in English, Bahasa Melayu, Chinese and Korean. Pure; browser-safe.
//
// A parent opens /c/<slug> from a link, mostly on a phone, usually upset or in a hurry about money. The words are plain, short and calm: what the page
// does, what it needs, what happens next, never a threat and never legal language. They are kept in this file (like the emails' words) rather than in
// Halo's own message files, because the page belongs to the parent, not to the signed-in app, and its four languages travel with the page.
//
// The page NEVER says: that there is a 30-day regulatory stop (the only date a parent is told is the practice target, "within 14 days"); whether an
// email address, a phone number or a request is known; or anything stored about them.
//
// [NATIVE REVIEW] The Malay, Chinese and Korean wording was written for this build and has not been read by a native speaker of each language. The
// Malay and Korean forms of the closure warning (Parent / Child account) and the declaration are the ones most worth a careful read. Also worth a read:
// the question "Does this bank account belong to you?", its Yes / No and the authorization letter sentence (form.bank.own, form.bank.holderOther, form.letter.why).
// ============================================================

import type { CustomerLocale } from "../types";

export interface PublicWords {
  language: string;
  skip: string;
  footer: string; // {workspace}
  step: { verify: string; details: string; done: string };
  unavailable: { title: string; body: string };
  busy: { title: string; body: string };
  verify: {
    title: string;
    intro: string;
    emailLabel: string;
    send: string;
    sending: string;
    sentTo: string; // {email}
    codeLabel: string;
    codeHelp: string;
    confirm: string;
    confirming: string;
    resend: string;
    change: string;
    confirmed: string; // {email}
    errors: {
      invalid_email: string;
      send_failed: string;
      rate_limited: string;
      wrong_code: string; // {left}
      expired: string;
      too_many_attempts: string;
      no_code: string;
      captcha_failed: string;
      unavailable: string;
      network: string;
    };
  };
  form: {
    aboutYou: string;
    name: { label: string; help: string };
    phone: { label: string; help: string };
    email: { label: string; help: string };
    bank: {
      title: string;
      intro: string;
      /** "Does this bank account belong to you, the Vircle account holder?": asked first, answered Yes or No (no default). */
      own: { question: string; yes: string; no: string; required: string };
      choice: string;
      choose: string;
      other: string;
      otherName: string;
      number: string;
      numberHelp: string;
      holder: string;
      holderHelp: string;
      /** The holder name's label while the answer is No (the account is somebody else's). */
      holderOther: string;
    };
    letter: { title: string; why: string; help: string; choose: string; none: string; remove: string; optionalTitle: string };
    declaration: { title: string; text: string };
    submit: string;
    submitting: string;
    fixAbove: string;
    problem: {
      required: string;
      invalid: string;
      too_long: string;
      must_acknowledge: string;
      not_a_choice: string;
      too_small: string;
      too_large: string;
      too_many_decimals: string;
      file_required: string;
      file_type: string;
      file_size: string;
    };
    errors: { session_invalid: string; rate_limited: string; failed: string; token: string; too_large: string; network: string; unavailable: string };
  };
  closure: {
    title: string;
    warning: string;
    childOnly: string;
    wantClose: string;
    yes: string;
    no: string;
    childrenFinished: string;
    allowancesStopped: string;
    reason: string;
    aim: string; // {days}
    declined: { title: string; body: string; back: string };
  };
  withdrawal: {
    title: string;
    note: string;
    amount: string;
    amountHelp: string; // {max}
    reasonKind: string;
    overTopup: string;
    other: string;
    reasonTextOther: string;
    reasonTextMore: string;
    transactionRefs: string;
    transactionRefsHelp: string;
    proof: string;
  };
  done: {
    title: string;
    reference: string;
    referenceByEmail: string;
    emailed: string; // {email}
    nextTitle: string;
    next1: string;
    next2Target: string; // {days}
    next2: string;
    next3: string;
    safety: string;
  };
}

const EN: PublicWords = {
  language: "Language",
  skip: "Skip to the form",
  footer: "This form is provided by {workspace}.",
  step: { verify: "Confirm your email", details: "Your request", done: "Done" },
  unavailable: { title: "This form is not available", body: "If you need help, please contact Customer Support." },
  busy: { title: "This page is busy", body: "Please wait a minute and try again." },
  verify: {
    title: "First, confirm your email address",
    intro: "We will send a 6-digit code to your email so that we know the address is yours. Nothing is sent to us until you finish the form.",
    emailLabel: "Email address",
    send: "Send me a code",
    sending: "Sending...",
    sentTo: "We sent a 6-digit code to {email}. It is valid for 15 minutes.",
    codeLabel: "6-digit code",
    codeHelp: "Check your inbox and your spam folder.",
    confirm: "Confirm",
    confirming: "Checking...",
    resend: "Send a new code",
    change: "Use a different email address",
    confirmed: "Email confirmed: {email}",
    errors: {
      invalid_email: "Please enter a valid email address.",
      send_failed: "We could not send the email right now. Please try again in a few minutes.",
      rate_limited: "Too many tries. Please wait a while and try again.",
      wrong_code: "That code is not right. You have {left} tries left.",
      expired: "That code has expired. Please ask for a new one.",
      too_many_attempts: "Too many wrong tries. Please ask for a new code.",
      no_code: "We could not use that code. Please ask for a new one.",
      captcha_failed: "We could not check that you are a person. Please try again.",
      unavailable: "This form is not available right now. Please try again later.",
      network: "We could not reach the server. Check your connection and try again.",
    },
  },
  form: {
    aboutYou: "About your account",
    name: { label: "Account holder name", help: "The name on your Vircle account." },
    phone: { label: "Registered phone number", help: "Format +6012334455667. It must be the number you used to create the account." },
    email: { label: "Email address (confirmed)", help: "We will write to this address." },
    bank: {
      title: "Bank account for the refund",
      intro: "Any refund is paid only into this bank account.",
      own: { question: "Does this bank account belong to you, the Vircle account holder?", yes: "Yes", no: "No", required: "Please choose Yes or No." },
      choice: "Bank",
      choose: "Choose your bank",
      other: "Other bank",
      otherName: "Name of your bank",
      number: "Bank account number",
      numberHelp: "Numbers only.",
      holder: "Name of the bank account holder",
      holderHelp: "As it appears on the bank account.",
      holderOther: "Name of the bank account holder (as on the bank account)",
    },
    letter: {
      title: "Authorization letter",
      why: "Because this bank account does not belong to you, we need an authorization letter. The letter must be signed by the bank account holder and must allow us to pay into this account.",
      help: "PDF, JPG or PNG, up to 10 MB.",
      choose: "Choose a file",
      none: "No file chosen",
      remove: "Remove",
      optionalTitle: "Proof of the transaction (optional)",
    },
    declaration: { title: "Declaration", text: "I declare that the details I have given are true and that I am the holder of this Vircle account." },
    submit: "Submit request",
    submitting: "Sending...",
    fixAbove: "Please check the fields marked below.",
    problem: {
      required: "Please fill this in.",
      invalid: "This does not look right.",
      too_long: "This is too long.",
      must_acknowledge: "Please tick this box to continue.",
      not_a_choice: "Please choose one of the options.",
      too_small: "Enter an amount above zero.",
      too_large: "This is more than this form accepts. Please contact Customer Support.",
      too_many_decimals: "Use at most two decimal places.",
      file_required: "Please add the file.",
      file_type: "Only PDF, JPG and PNG files are accepted.",
      file_size: "This file is larger than 10 MB.",
    },
    errors: {
      session_invalid: "Your email confirmation has ended. Please confirm your email address again.",
      rate_limited: "Too many tries. Please wait a while and try again.",
      failed: "We could not send your request. Nothing was lost. Please try again in a few minutes.",
      token: "This page was open for a long time. Please try again.",
      too_large: "The files are too large. Please use smaller files.",
      network: "We could not reach the server. Check your connection and try again.",
      unavailable: "This form is not available right now. Please try again later.",
    },
  },
  closure: {
    title: "Close your Vircle E-Wallet account",
    warning: "Closing your account closes both the Parent (Principal) account and every Child (Supplementary) account for good. This cannot be undone.",
    childOnly: "If you only want to close a Child account, please contact Customer Support instead of using this form.",
    wantClose: "Do you want to close your E-Wallet account?",
    yes: "Yes, close my account",
    no: "No, I do not want to close it",
    childrenFinished: "All of my children have completed school.",
    allowancesStopped: "All active allowances to my children have been stopped and cancelled in the app.",
    reason: "Reason for closing (optional)",
    aim: "We aim to complete closure within {days} days of your request.",
    declined: { title: "No request was made", body: "You chose not to close your account, so nothing has been sent and nothing will change. You can close this page.", back: "Go back to the form" },
  },
  withdrawal: {
    title: "Withdraw funds from your Vircle E-Wallet account",
    note: "This asks for money to be paid out. It does not close your account.",
    amount: "Amount to withdraw (RM)",
    amountHelp: "Up to RM {max}.",
    reasonKind: "Why are you asking for this withdrawal?",
    overTopup: "I topped up more than I meant to",
    other: "Another reason",
    reasonTextOther: "Please tell us more",
    reasonTextMore: "Anything else we should know (optional)",
    transactionRefs: "Transaction reference(s) (optional)",
    transactionRefsHelp: "Copy them from your app, one per line.",
    proof: "Proof of the transaction (optional)",
  },
  done: {
    title: "We have received your request",
    reference: "Your reference",
    referenceByEmail: "Your reference is in the confirmation email we are sending you.",
    emailed: "We sent a confirmation to {email}.",
    nextTitle: "What happens next",
    next1: "We check that the request really comes from you. A member of our team may contact you.",
    next2Target: "We review your request. We aim to complete closure within {days} days of your request.",
    next2: "We review your request.",
    next3: "We email you when it is done, or if we need anything more from you.",
    safety: "We will never ask you for a password or a code by message. Please do not share your bank details with anyone who asks for them.",
  },
};

const MS: PublicWords = {
  language: "Bahasa",
  skip: "Langkau ke borang",
  footer: "Borang ini disediakan oleh {workspace}.",
  step: { verify: "Sahkan e-mel anda", details: "Permintaan anda", done: "Selesai" },
  unavailable: { title: "Borang ini tidak tersedia", body: "Jika anda memerlukan bantuan, sila hubungi Sokongan Pelanggan." },
  busy: { title: "Halaman ini sibuk", body: "Sila tunggu seminit dan cuba lagi." },
  verify: {
    title: "Pertama, sahkan alamat e-mel anda",
    intro: "Kami akan menghantar kod 6 digit ke e-mel anda supaya kami tahu alamat itu milik anda. Tiada apa-apa dihantar kepada kami sehingga anda melengkapkan borang.",
    emailLabel: "Alamat e-mel",
    send: "Hantar kod kepada saya",
    sending: "Menghantar...",
    sentTo: "Kami telah menghantar kod 6 digit ke {email}. Kod ini sah selama 15 minit.",
    codeLabel: "Kod 6 digit",
    codeHelp: "Semak peti masuk dan folder spam anda.",
    confirm: "Sahkan",
    confirming: "Menyemak...",
    resend: "Hantar kod baharu",
    change: "Guna alamat e-mel lain",
    confirmed: "E-mel disahkan: {email}",
    errors: {
      invalid_email: "Sila masukkan alamat e-mel yang sah.",
      send_failed: "Kami tidak dapat menghantar e-mel sekarang. Sila cuba lagi dalam beberapa minit.",
      rate_limited: "Terlalu banyak percubaan. Sila tunggu sebentar dan cuba lagi.",
      wrong_code: "Kod itu tidak betul. Anda ada {left} percubaan lagi.",
      expired: "Kod itu telah tamat tempoh. Sila minta kod baharu.",
      too_many_attempts: "Terlalu banyak percubaan yang salah. Sila minta kod baharu.",
      no_code: "Kami tidak dapat menggunakan kod itu. Sila minta kod baharu.",
      captcha_failed: "Kami tidak dapat mengesahkan bahawa anda seorang manusia. Sila cuba lagi.",
      unavailable: "Borang ini tidak tersedia sekarang. Sila cuba lagi nanti.",
      network: "Kami tidak dapat menghubungi pelayan. Semak sambungan anda dan cuba lagi.",
    },
  },
  form: {
    aboutYou: "Mengenai akaun anda",
    name: { label: "Nama pemegang akaun", help: "Nama pada akaun Vircle anda." },
    phone: { label: "Nombor telefon berdaftar", help: "Format +6012334455667. Ia mestilah nombor yang anda gunakan untuk membuka akaun." },
    email: { label: "Alamat e-mel (telah disahkan)", help: "Kami akan menghubungi anda di alamat ini." },
    bank: {
      title: "Akaun bank untuk bayaran balik",
      intro: "Sebarang bayaran balik hanya dibuat ke akaun bank ini.",
      own: { question: "Adakah akaun bank ini milik anda, pemegang akaun Vircle?", yes: "Ya", no: "Tidak", required: "Sila pilih Ya atau Tidak." },
      choice: "Bank",
      choose: "Pilih bank anda",
      other: "Bank lain",
      otherName: "Nama bank anda",
      number: "Nombor akaun bank",
      numberHelp: "Nombor sahaja.",
      holder: "Nama pemegang akaun bank",
      holderHelp: "Seperti yang tertera pada akaun bank.",
      holderOther: "Nama pemegang akaun bank (seperti pada akaun bank)",
    },
    letter: {
      title: "Surat kebenaran",
      why: "Oleh sebab akaun bank ini bukan milik anda, kami memerlukan surat kebenaran. Surat itu mesti ditandatangani oleh pemegang akaun bank dan membenarkan kami membuat bayaran ke akaun ini.",
      help: "PDF, JPG atau PNG, sehingga 10 MB.",
      choose: "Pilih fail",
      none: "Tiada fail dipilih",
      remove: "Buang",
      optionalTitle: "Bukti transaksi (pilihan)",
    },
    declaration: { title: "Perakuan", text: "Saya mengesahkan bahawa maklumat yang saya berikan adalah benar dan saya ialah pemegang akaun Vircle ini." },
    submit: "Hantar permintaan",
    submitting: "Menghantar...",
    fixAbove: "Sila semak ruangan yang ditandakan di bawah.",
    problem: {
      required: "Sila isi ruangan ini.",
      invalid: "Ini nampaknya tidak betul.",
      too_long: "Ini terlalu panjang.",
      must_acknowledge: "Sila tandakan kotak ini untuk meneruskan.",
      not_a_choice: "Sila pilih salah satu pilihan.",
      too_small: "Masukkan jumlah melebihi sifar.",
      too_large: "Ini melebihi apa yang diterima oleh borang ini. Sila hubungi Sokongan Pelanggan.",
      too_many_decimals: "Gunakan paling banyak dua tempat perpuluhan.",
      file_required: "Sila tambah fail.",
      file_type: "Hanya fail PDF, JPG dan PNG diterima.",
      file_size: "Fail ini lebih besar daripada 10 MB.",
    },
    errors: {
      session_invalid: "Pengesahan e-mel anda telah tamat. Sila sahkan alamat e-mel anda sekali lagi.",
      rate_limited: "Terlalu banyak percubaan. Sila tunggu sebentar dan cuba lagi.",
      failed: "Kami tidak dapat menghantar permintaan anda. Tiada apa yang hilang. Sila cuba lagi dalam beberapa minit.",
      token: "Halaman ini telah dibuka terlalu lama. Sila cuba lagi.",
      too_large: "Fail terlalu besar. Sila gunakan fail yang lebih kecil.",
      network: "Kami tidak dapat menghubungi pelayan. Semak sambungan anda dan cuba lagi.",
      unavailable: "Borang ini tidak tersedia sekarang. Sila cuba lagi nanti.",
    },
  },
  closure: {
    title: "Tutup akaun E-Wallet Vircle anda",
    warning: "Menutup akaun anda akan menutup akaun Ibu Bapa (Utama) dan setiap akaun Anak (Tambahan) secara kekal. Ini tidak boleh dibatalkan.",
    childOnly: "Jika anda hanya mahu menutup akaun Anak, sila hubungi Sokongan Pelanggan dan bukannya menggunakan borang ini.",
    wantClose: "Adakah anda mahu menutup akaun E-Wallet anda?",
    yes: "Ya, tutup akaun saya",
    no: "Tidak, saya tidak mahu menutupnya",
    childrenFinished: "Semua anak saya telah tamat persekolahan.",
    allowancesStopped: "Semua elaun aktif kepada anak saya telah dihentikan dan dibatalkan dalam aplikasi.",
    reason: "Sebab penutupan (pilihan)",
    aim: "Kami berusaha menyiapkan penutupan akaun dalam tempoh {days} hari daripada tarikh permintaan anda.",
    declined: { title: "Tiada permintaan dibuat", body: "Anda memilih untuk tidak menutup akaun anda, jadi tiada apa-apa dihantar dan tiada apa yang akan berubah. Anda boleh menutup halaman ini.", back: "Kembali ke borang" },
  },
  withdrawal: {
    title: "Keluarkan dana daripada akaun E-Wallet Vircle anda",
    note: "Ini ialah permintaan untuk mengeluarkan wang. Ia tidak menutup akaun anda.",
    amount: "Jumlah untuk dikeluarkan (RM)",
    amountHelp: "Sehingga RM {max}.",
    reasonKind: "Mengapa anda membuat permintaan pengeluaran ini?",
    overTopup: "Saya menambah nilai lebih daripada yang dimaksudkan",
    other: "Sebab lain",
    reasonTextOther: "Sila ceritakan dengan lebih lanjut",
    reasonTextMore: "Apa-apa lagi yang perlu kami tahu (pilihan)",
    transactionRefs: "Rujukan transaksi (pilihan)",
    transactionRefsHelp: "Salin daripada aplikasi anda, satu pada setiap baris.",
    proof: "Bukti transaksi (pilihan)",
  },
  done: {
    title: "Kami telah menerima permintaan anda",
    reference: "Rujukan anda",
    referenceByEmail: "Rujukan anda ada dalam e-mel pengesahan yang kami hantar kepada anda.",
    emailed: "Kami telah menghantar pengesahan ke {email}.",
    nextTitle: "Apa yang berlaku seterusnya",
    next1: "Kami menyemak bahawa permintaan ini benar-benar datang daripada anda. Seorang ahli pasukan kami mungkin akan menghubungi anda.",
    next2Target: "Kami menyemak permintaan anda. Kami berusaha menyiapkan penutupan akaun dalam tempoh {days} hari daripada tarikh permintaan anda.",
    next2: "Kami menyemak permintaan anda.",
    next3: "Kami akan menghantar e-mel kepada anda apabila ia selesai, atau jika kami memerlukan maklumat tambahan daripada anda.",
    safety: "Kami tidak akan sekali-kali meminta kata laluan atau kod daripada anda melalui mesej. Sila jangan kongsi butiran bank anda dengan sesiapa yang memintanya.",
  },
};

const ZH: PublicWords = {
  language: "语言",
  skip: "跳到表单",
  footer: "此表单由 {workspace} 提供。",
  step: { verify: "验证邮箱", details: "您的请求", done: "完成" },
  unavailable: { title: "此表单暂不可用", body: "如需帮助，请联系客户支持。" },
  busy: { title: "此页面较忙", body: "请稍等一分钟后再试。" },
  verify: {
    title: "首先，请验证您的邮箱地址",
    intro: "我们会向您的邮箱发送一个 6 位验证码，以确认该邮箱属于您。在您完成表单之前，不会向我们提交任何内容。",
    emailLabel: "邮箱地址",
    send: "发送验证码给我",
    sending: "正在发送…",
    sentTo: "我们已向 {email} 发送了 6 位验证码，有效期 15 分钟。",
    codeLabel: "6 位验证码",
    codeHelp: "请查看收件箱和垃圾邮件文件夹。",
    confirm: "确认",
    confirming: "正在检查…",
    resend: "重新发送验证码",
    change: "使用其他邮箱地址",
    confirmed: "邮箱已验证：{email}",
    errors: {
      invalid_email: "请输入有效的邮箱地址。",
      send_failed: "暂时无法发送邮件，请几分钟后再试。",
      rate_limited: "尝试次数过多，请稍后再试。",
      wrong_code: "验证码不正确，您还有 {left} 次机会。",
      expired: "验证码已过期，请重新获取。",
      too_many_attempts: "错误次数过多，请重新获取验证码。",
      no_code: "无法使用该验证码，请重新获取。",
      captcha_failed: "无法确认您是真人，请重试。",
      unavailable: "此表单暂时不可用，请稍后再试。",
      network: "无法连接到服务器，请检查网络后重试。",
    },
  },
  form: {
    aboutYou: "关于您的账户",
    name: { label: "账户持有人姓名", help: "您的 Vircle 账户上的姓名。" },
    phone: { label: "注册手机号码", help: "格式：+6012334455667。必须是您注册账户时使用的号码。" },
    email: { label: "邮箱地址（已验证）", help: "我们会通过此地址联系您。" },
    bank: {
      title: "用于退款的银行账户",
      intro: "任何退款只会转入此银行账户。",
      own: { question: "这个银行账户是否属于您本人（Vircle 账户持有人）？", yes: "是", no: "否", required: "请选择“是”或“否”。" },
      choice: "银行",
      choose: "请选择您的银行",
      other: "其他银行",
      otherName: "您的银行名称",
      number: "银行账号",
      numberHelp: "仅填数字。",
      holder: "银行账户持有人姓名",
      holderHelp: "与银行账户上的姓名一致。",
      holderOther: "银行账户持有人姓名（与银行账户上的一致）",
    },
    letter: {
      title: "授权书",
      why: "由于此银行账户不属于您本人，我们需要一份授权书。授权书必须由银行账户持有人签署，并允许我们将款项转入该账户。",
      help: "PDF、JPG 或 PNG，最大 10 MB。",
      choose: "选择文件",
      none: "未选择文件",
      remove: "移除",
      optionalTitle: "交易证明（选填）",
    },
    declaration: { title: "声明", text: "我声明我所提供的资料真实无误，并且我是此 Vircle 账户的持有人。" },
    submit: "提交请求",
    submitting: "正在发送…",
    fixAbove: "请检查下方标出的项目。",
    problem: {
      required: "请填写此项。",
      invalid: "此项似乎不正确。",
      too_long: "内容太长。",
      must_acknowledge: "请勾选此项以继续。",
      not_a_choice: "请选择其中一个选项。",
      too_small: "请输入大于零的金额。",
      too_large: "超出此表单可接受的金额，请联系客户支持。",
      too_many_decimals: "最多保留两位小数。",
      file_required: "请添加文件。",
      file_type: "仅接受 PDF、JPG 和 PNG 文件。",
      file_size: "此文件超过 10 MB。",
    },
    errors: {
      session_invalid: "您的邮箱验证已失效，请重新验证邮箱地址。",
      rate_limited: "尝试次数过多，请稍后再试。",
      failed: "我们无法发送您的请求，您的内容没有丢失，请几分钟后再试。",
      token: "此页面已打开很长时间，请重试。",
      too_large: "文件太大，请使用较小的文件。",
      network: "无法连接到服务器，请检查网络后重试。",
      unavailable: "此表单暂时不可用，请稍后再试。",
    },
  },
  closure: {
    title: "关闭您的 Vircle 电子钱包账户",
    warning: "关闭账户将永久关闭家长（主）账户以及每一个子女（附属）账户，此操作无法撤销。",
    childOnly: "如果您只想关闭子女账户，请联系客户支持，而不是使用此表单。",
    wantClose: "您是否要关闭您的电子钱包账户？",
    yes: "是，关闭我的账户",
    no: "否，我不想关闭",
    childrenFinished: "我所有的孩子都已完成学业。",
    allowancesStopped: "我已在应用中停止并取消所有发给孩子的有效零用钱。",
    reason: "关闭原因（选填）",
    aim: "我们力争在您提出请求后的 {days} 天内完成账户关闭。",
    declined: { title: "未提交任何请求", body: "您选择不关闭账户，因此没有发送任何内容，也不会有任何变化。您可以关闭此页面。", back: "返回表单" },
  },
  withdrawal: {
    title: "从您的 Vircle 电子钱包账户提取资金",
    note: "这是申请将资金转出，不会关闭您的账户。",
    amount: "提取金额（令吉）",
    amountHelp: "最多 RM {max}。",
    reasonKind: "您为什么要申请提取？",
    overTopup: "我充值的金额超出了预期",
    other: "其他原因",
    reasonTextOther: "请告诉我们更多情况",
    reasonTextMore: "还有什么需要我们了解的（选填）",
    transactionRefs: "交易参考编号（选填）",
    transactionRefsHelp: "请从应用中复制，每行一个。",
    proof: "交易证明（选填）",
  },
  done: {
    title: "我们已收到您的请求",
    reference: "您的参考编号",
    referenceByEmail: "您的参考编号在我们发给您的确认邮件中。",
    emailed: "我们已向 {email} 发送了确认邮件。",
    nextTitle: "接下来会怎样",
    next1: "我们会核实这个请求确实来自您本人，我们的工作人员可能会联系您。",
    next2Target: "我们会审核您的请求。我们力争在您提出请求后的 {days} 天内完成账户关闭。",
    next2: "我们会审核您的请求。",
    next3: "处理完成后，或需要您提供更多信息时，我们会发送电子邮件告知您。",
    safety: "我们绝不会通过消息向您索要密码或验证码。请不要把您的银行资料告诉任何向您索取的人。",
  },
};

const KO: PublicWords = {
  language: "언어",
  skip: "양식으로 건너뛰기",
  footer: "이 양식은 {workspace}에서 제공합니다.",
  step: { verify: "이메일 확인", details: "요청 내용", done: "완료" },
  unavailable: { title: "이 양식은 현재 이용할 수 없습니다", body: "도움이 필요하시면 고객 지원에 문의해 주세요." },
  busy: { title: "이 페이지가 혼잡합니다", body: "잠시 후 다시 시도해 주세요." },
  verify: {
    title: "먼저 이메일 주소를 확인해 주세요",
    intro: "이메일 주소가 본인의 것임을 확인하기 위해 6자리 코드를 보내 드립니다. 양식을 끝까지 작성해 제출하기 전에는 아무것도 전달되지 않습니다.",
    emailLabel: "이메일 주소",
    send: "코드 받기",
    sending: "보내는 중...",
    sentTo: "{email}(으)로 6자리 코드를 보냈습니다. 15분 동안 유효합니다.",
    codeLabel: "6자리 코드",
    codeHelp: "받은 편지함과 스팸 편지함을 확인해 주세요.",
    confirm: "확인",
    confirming: "확인 중...",
    resend: "새 코드 받기",
    change: "다른 이메일 주소 사용",
    confirmed: "이메일 확인됨: {email}",
    errors: {
      invalid_email: "올바른 이메일 주소를 입력해 주세요.",
      send_failed: "지금은 이메일을 보낼 수 없습니다. 몇 분 후 다시 시도해 주세요.",
      rate_limited: "시도 횟수가 너무 많습니다. 잠시 후 다시 시도해 주세요.",
      wrong_code: "코드가 맞지 않습니다. {left}번 더 시도할 수 있습니다.",
      expired: "코드가 만료되었습니다. 새 코드를 요청해 주세요.",
      too_many_attempts: "잘못 입력한 횟수가 너무 많습니다. 새 코드를 요청해 주세요.",
      no_code: "이 코드를 사용할 수 없습니다. 새 코드를 요청해 주세요.",
      captcha_failed: "사람임을 확인하지 못했습니다. 다시 시도해 주세요.",
      unavailable: "이 양식은 지금 이용할 수 없습니다. 나중에 다시 시도해 주세요.",
      network: "서버에 연결할 수 없습니다. 연결 상태를 확인하고 다시 시도해 주세요.",
    },
  },
  form: {
    aboutYou: "계정 정보",
    name: { label: "계정 명의자 이름", help: "Vircle 계정에 등록된 이름입니다." },
    phone: { label: "등록된 전화번호", help: "형식: +6012334455667. 계정을 만들 때 사용한 번호여야 합니다." },
    email: { label: "이메일 주소(확인됨)", help: "이 주소로 연락드립니다." },
    bank: {
      title: "환불받을 은행 계좌",
      intro: "환불은 이 은행 계좌로만 지급됩니다.",
      own: { question: "이 은행 계좌는 Vircle 계정 명의자 본인의 계좌입니까?", yes: "예", no: "아니요", required: "'예' 또는 '아니요'를 선택해 주세요." },
      choice: "은행",
      choose: "은행을 선택하세요",
      other: "기타 은행",
      otherName: "은행 이름",
      number: "은행 계좌 번호",
      numberHelp: "숫자만 입력하세요.",
      holder: "은행 계좌 예금주 이름",
      holderHelp: "은행 계좌에 표시된 이름과 같게 입력하세요.",
      holderOther: "은행 계좌 예금주 이름(은행 계좌에 표시된 대로)",
    },
    letter: {
      title: "위임장",
      why: "이 은행 계좌는 본인 명의가 아니므로 위임장이 필요합니다. 위임장은 은행 계좌 예금주가 서명해야 하며, 이 계좌로 입금하는 것을 허락하는 내용이어야 합니다.",
      help: "PDF, JPG 또는 PNG, 최대 10MB.",
      choose: "파일 선택",
      none: "선택한 파일 없음",
      remove: "삭제",
      optionalTitle: "거래 증빙(선택)",
    },
    declaration: { title: "확인 및 선언", text: "제가 제공한 정보는 사실이며, 저는 이 Vircle 계정의 명의자임을 선언합니다." },
    submit: "요청 제출",
    submitting: "보내는 중...",
    fixAbove: "아래에 표시된 항목을 확인해 주세요.",
    problem: {
      required: "이 항목을 입력해 주세요.",
      invalid: "올바르지 않은 것 같습니다.",
      too_long: "너무 깁니다.",
      must_acknowledge: "계속하려면 이 항목에 체크해 주세요.",
      not_a_choice: "선택지 중 하나를 골라 주세요.",
      too_small: "0보다 큰 금액을 입력해 주세요.",
      too_large: "이 양식에서 받을 수 있는 금액을 넘습니다. 고객 지원에 문의해 주세요.",
      too_many_decimals: "소수점 둘째 자리까지만 입력할 수 있습니다.",
      file_required: "파일을 추가해 주세요.",
      file_type: "PDF, JPG, PNG 파일만 올릴 수 있습니다.",
      file_size: "파일이 10MB보다 큽니다.",
    },
    errors: {
      session_invalid: "이메일 확인이 만료되었습니다. 이메일 주소를 다시 확인해 주세요.",
      rate_limited: "시도 횟수가 너무 많습니다. 잠시 후 다시 시도해 주세요.",
      failed: "요청을 보내지 못했습니다. 입력하신 내용은 사라지지 않았습니다. 몇 분 후 다시 시도해 주세요.",
      token: "이 페이지가 오래 열려 있었습니다. 다시 시도해 주세요.",
      too_large: "파일이 너무 큽니다. 더 작은 파일을 사용해 주세요.",
      network: "서버에 연결할 수 없습니다. 연결 상태를 확인하고 다시 시도해 주세요.",
      unavailable: "이 양식은 지금 이용할 수 없습니다. 나중에 다시 시도해 주세요.",
    },
  },
  closure: {
    title: "Vircle E-Wallet 계정 해지",
    warning: "계정을 해지하면 부모(주) 계정과 모든 자녀(보조) 계정이 영구적으로 해지됩니다. 되돌릴 수 없습니다.",
    childOnly: "자녀 계정만 해지하려면 이 양식 대신 고객 지원에 문의해 주세요.",
    wantClose: "E-Wallet 계정을 해지하시겠습니까?",
    yes: "예, 계정을 해지합니다",
    no: "아니요, 해지하지 않습니다",
    childrenFinished: "자녀가 모두 학교를 마쳤습니다.",
    allowancesStopped: "자녀에게 지급 중이던 모든 용돈을 앱에서 중단하고 취소했습니다.",
    reason: "해지 사유(선택)",
    aim: "요청일로부터 {days}일 이내에 해지를 완료하는 것을 목표로 합니다.",
    declined: { title: "요청이 접수되지 않았습니다", body: "계정을 해지하지 않기로 하셨으므로 아무것도 전송되지 않았고 달라지는 것도 없습니다. 이 페이지를 닫으셔도 됩니다.", back: "양식으로 돌아가기" },
  },
  withdrawal: {
    title: "Vircle E-Wallet 계정에서 자금 인출",
    note: "돈을 지급해 달라는 요청입니다. 계정은 해지되지 않습니다.",
    amount: "인출 금액(RM)",
    amountHelp: "최대 RM {max}.",
    reasonKind: "인출을 요청하는 이유는 무엇인가요?",
    overTopup: "의도한 것보다 많이 충전했습니다",
    other: "기타 사유",
    reasonTextOther: "자세히 알려 주세요",
    reasonTextMore: "그 밖에 알려 주실 내용(선택)",
    transactionRefs: "거래 참조 번호(선택)",
    transactionRefsHelp: "앱에서 복사해 한 줄에 하나씩 붙여 넣어 주세요.",
    proof: "거래 증빙(선택)",
  },
  done: {
    title: "요청을 접수했습니다",
    reference: "참조 번호",
    referenceByEmail: "참조 번호는 보내 드리는 확인 이메일에 있습니다.",
    emailed: "{email}(으)로 확인 이메일을 보냈습니다.",
    nextTitle: "앞으로의 진행 과정",
    next1: "요청이 본인에게서 온 것이 맞는지 확인합니다. 담당자가 연락드릴 수 있습니다.",
    next2Target: "요청을 검토합니다. 요청일로부터 {days}일 이내에 해지를 완료하는 것을 목표로 합니다.",
    next2: "요청을 검토합니다.",
    next3: "처리가 끝났을 때, 또는 추가로 필요한 것이 있을 때 이메일로 알려 드립니다.",
    safety: "저희는 메시지로 비밀번호나 코드를 요구하지 않습니다. 은행 정보를 요구하는 사람에게 알려 주지 마세요.",
  },
};

const DICT: Record<CustomerLocale, PublicWords> = { en: EN, ms: MS, zh: ZH, ko: KO };

export const publicWords = (locale: CustomerLocale): PublicWords => DICT[locale] ?? EN;

/** Fill `{name}` placeholders (values put on one line). */
export function fillWords(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]).replace(/[\r\n]+/g, " ").trim() : m));
}

/** The names of the languages, each written in itself (so a person can find theirs). */
export const LANGUAGE_NAMES: Record<CustomerLocale, string> = { en: "English", ms: "Bahasa Melayu", zh: "中文", ko: "한국어" };

export const ALL_PUBLIC_WORDS: Record<CustomerLocale, PublicWords> = DICT;
