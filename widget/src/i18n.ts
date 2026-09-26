// ============================================================
// Widget strings: English, Bahasa Melayu (ms), Mandarin (zh).
// Locale comes from the loader's data-lang, then <html lang>, then the
// browser language; anything unrecognised falls back to English.
// ============================================================
import type { Locale } from './types'

const en = {
  openChat: 'Open chat',
  closeChat: 'Close chat',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  retry: 'Try again',
  back: 'Back',
  cancel: 'Cancel',
  loadingChat: 'Loading chat…',

  choiceTitle: 'How can we help?',
  choiceExisting: "I'm already a Vircle user",
  choiceExistingHint: 'Find your account so we can help faster.',
  choiceEnquiry: 'I have an enquiry',
  choiceEnquiryHint: 'Tell us who you are and what you need.',
  choiceGuest: 'Just chat, skip this',

  claimTitle: 'Find your account',
  claimHint: 'Enter the phone number or email you use with Vircle.',
  fieldPhone: 'Phone number',
  fieldPhonePh: 'e.g. 60123456789',
  fieldEmail: 'Email',
  fieldEmailPh: 'you@example.com',
  fieldName: 'Your name',
  fieldNameOptional: 'Your name (optional)',
  claimSubmit: 'Start chat',
  starting: 'Starting…',
  contactEither: 'Phone or email — at least one.',
  errName: 'Please enter your name.',
  errContact: 'Enter a phone number or an email.',
  errEmail: 'That email does not look right.',
  errPhone: 'That phone number does not look right.',
  errMessage: 'Please write a short message (up to 2000 characters).',
  errConsent: 'Please tick the box to continue.',
  errClaim: 'We could not use those details. Please check them.',

  verifyTitle: 'Enter your code',
  verifyHint: "We sent a 6-digit code to {destination}. It expires in 10 minutes.",
  fieldCode: 'Verification code',
  fieldCodePh: '123456',
  errCode: 'Enter the code we sent you.',
  verifying: 'Checking…',
  verifySubmit: 'Verify',
  resendCode: 'Resend code',
  useDifferentNumber: 'Use a different number',
  errVerifyCode: 'That code did not work. Please try again.',

  enquiryTitle: 'Send us an enquiry',
  fieldRole: 'I am a',
  roleParent: 'Parent',
  roleSchool: 'School',
  roleMerchant: 'Merchant',
  roleOther: 'Other',
  fieldMessage: 'Your message',
  fieldMessagePh: 'How can we help?',
  consent: 'I agree that Vircle may contact me about this enquiry.',
  submitEnquiry: 'Send enquiry',
  enquirySent: 'Thanks! We have your enquiry and will reply here soon.',

  welcomeBack: 'Welcome back, {name}!',
  welcomeBackNoName: 'Welcome back!',
  welcomeNew: 'Thanks! We will get you sorted.',
  linkAccount: 'Already a Vircle user? Link your account',
  linkSubmit: 'Link',

  typeMessage: 'Type a message',
  send: 'Send',
  attach: 'Attach a file',
  emoji: 'Emoji',
  voiceNote: 'Record a voice message',
  recording: 'Recording…',
  stopAndSend: 'Stop and send',
  cancelRecording: 'Discard recording',
  micDenied: 'Microphone access was blocked. Allow it in your browser to send voice messages.',
  micUnsupported: 'Voice messages are not supported in this browser.',
  recordingFailed: 'Could not record. Please try again.',
  micSilent: "We can't hear anything. Your microphone may be muted, or the wrong one is selected.",
  micSilentSend: 'No sound was picked up from this microphone. Send it anyway?',
  micChange: 'Change microphone',
  micChoose: 'Choose a microphone',
  micNone: 'No microphone was found.',
  micFallbackName: 'Microphone {n}',
  sendAnyway: 'Send anyway',
  discard: 'Discard',

  today: 'Today',
  yesterday: 'Yesterday',
  unreadOne: '1 unread message',
  unreadMany: '{n} unread messages',
  loadEarlier: 'Load earlier messages',
  loadingEarlier: 'Loading…',
  emptyChat: 'Say hello — we are here to help.',

  captionPh: 'Add a caption…',
  sendFile: 'Send',
  closePreview: 'Close preview',
  fileTooLarge: 'That file is larger than {max}.',
  fileTypeNotAllowed: 'That type of file cannot be sent here.',
  uploadFailed: 'Upload failed. Tap to try again.',
  sendFailed: 'Not sent. Tap to try again.',
  rateLimited: 'You are doing that too often. Please wait a moment and try again.',
  networkError: 'Network problem. Check your connection and try again.',
  genericError: 'Something went wrong. Please try again.',
  messageUnavailable: 'This message could not be displayed.',
  historyFailed: 'Could not load your earlier messages.',
  chatCrashed: 'The chat ran into a problem.',

  imageAlt: 'Photo',
  videoLabel: 'Video',
  voiceMessage: 'Voice message',
  play: 'Play',
  pause: 'Pause',
  download: 'Download',
  openImage: 'Open photo',

  emojiSearch: 'Search emoji',
  emojiRecent: 'Recent',
  emojiNone: 'No emoji found',
  emojiLoading: 'Loading emoji…',
  emojiFailed: 'Emoji could not be loaded.',
  catSmileys: 'Smileys',
  catPeople: 'People',
  catAnimals: 'Animals',
  catFood: 'Food',
  catTravel: 'Travel',
  catActivities: 'Activities',
  catObjects: 'Objects',
  catSymbols: 'Symbols',
  catFlags: 'Flags',

  tickPending: 'Sending',
  tickSent: 'Sent',
  tickDelivered: 'Delivered',
  tickRead: 'Read',
} as const

export type StringKey = keyof typeof en
type Dict = Record<StringKey, string>

const ms: Dict = {
  openChat: 'Buka sembang',
  closeChat: 'Tutup sembang',
  connecting: 'Menyambung…',
  reconnecting: 'Menyambung semula…',
  retry: 'Cuba lagi',
  back: 'Kembali',
  cancel: 'Batal',
  loadingChat: 'Memuatkan sembang…',

  choiceTitle: 'Bagaimana kami boleh membantu?',
  choiceExisting: 'Saya sudah pengguna Vircle',
  choiceExistingHint: 'Cari akaun anda supaya kami dapat membantu dengan lebih cepat.',
  choiceEnquiry: 'Saya ada pertanyaan',
  choiceEnquiryHint: 'Beritahu kami siapa anda dan apa yang anda perlukan.',
  choiceGuest: 'Sembang sahaja, langkau ini',

  claimTitle: 'Cari akaun anda',
  claimHint: 'Masukkan nombor telefon atau e-mel yang anda guna dengan Vircle.',
  fieldPhone: 'Nombor telefon',
  fieldPhonePh: 'cth. 60123456789',
  fieldEmail: 'E-mel',
  fieldEmailPh: 'anda@contoh.com',
  fieldName: 'Nama anda',
  fieldNameOptional: 'Nama anda (pilihan)',
  claimSubmit: 'Mula sembang',
  starting: 'Memulakan…',
  contactEither: 'Telefon atau e-mel — sekurang-kurangnya satu.',
  errName: 'Sila masukkan nama anda.',
  errContact: 'Masukkan nombor telefon atau e-mel.',
  errEmail: 'E-mel itu nampaknya tidak betul.',
  errPhone: 'Nombor telefon itu nampaknya tidak betul.',
  errMessage: 'Sila tulis mesej ringkas (sehingga 2000 aksara).',
  errConsent: 'Sila tandakan kotak untuk meneruskan.',
  errClaim: 'Kami tidak dapat menggunakan butiran itu. Sila semak semula.',

  verifyTitle: 'Masukkan kod anda',
  verifyHint: 'Kami telah menghantar kod 6 digit ke {destination}. Ia tamat tempoh dalam 10 minit.',
  fieldCode: 'Kod pengesahan',
  fieldCodePh: '123456',
  errCode: 'Masukkan kod yang kami hantar kepada anda.',
  verifying: 'Menyemak…',
  verifySubmit: 'Sahkan',
  resendCode: 'Hantar semula kod',
  useDifferentNumber: 'Guna nombor lain',
  errVerifyCode: 'Kod itu tidak berjaya. Sila cuba lagi.',

  enquiryTitle: 'Hantar pertanyaan kepada kami',
  fieldRole: 'Saya seorang',
  roleParent: 'Ibu bapa',
  roleSchool: 'Sekolah',
  roleMerchant: 'Peniaga',
  roleOther: 'Lain-lain',
  fieldMessage: 'Mesej anda',
  fieldMessagePh: 'Bagaimana kami boleh membantu?',
  consent: 'Saya bersetuju Vircle boleh menghubungi saya mengenai pertanyaan ini.',
  submitEnquiry: 'Hantar pertanyaan',
  enquirySent: 'Terima kasih! Kami telah menerima pertanyaan anda dan akan membalas di sini tidak lama lagi.',

  welcomeBack: 'Selamat kembali, {name}!',
  welcomeBackNoName: 'Selamat kembali!',
  welcomeNew: 'Terima kasih! Kami akan membantu anda.',
  linkAccount: 'Sudah pengguna Vircle? Pautkan akaun anda',
  linkSubmit: 'Pautkan',

  typeMessage: 'Taip mesej',
  send: 'Hantar',
  attach: 'Lampirkan fail',
  emoji: 'Emoji',
  voiceNote: 'Rakam mesej suara',
  recording: 'Merakam…',
  stopAndSend: 'Berhenti dan hantar',
  cancelRecording: 'Buang rakaman',
  micDenied: 'Akses mikrofon disekat. Benarkan dalam pelayar anda untuk menghantar mesej suara.',
  micUnsupported: 'Mesej suara tidak disokong dalam pelayar ini.',
  recordingFailed: 'Tidak dapat merakam. Sila cuba lagi.',
  micSilent: 'Kami tidak dapat mendengar apa-apa. Mikrofon anda mungkin dimatikan, atau mikrofon yang salah dipilih.',
  micSilentSend: 'Tiada bunyi dikesan daripada mikrofon ini. Hantar juga?',
  micChange: 'Tukar mikrofon',
  micChoose: 'Pilih mikrofon',
  micNone: 'Tiada mikrofon ditemui.',
  micFallbackName: 'Mikrofon {n}',
  sendAnyway: 'Hantar juga',
  discard: 'Buang',

  today: 'Hari ini',
  yesterday: 'Semalam',
  unreadOne: '1 mesej belum dibaca',
  unreadMany: '{n} mesej belum dibaca',
  loadEarlier: 'Muat mesej terdahulu',
  loadingEarlier: 'Memuatkan…',
  emptyChat: 'Ucapkan helo — kami sedia membantu.',

  captionPh: 'Tambah kapsyen…',
  sendFile: 'Hantar',
  closePreview: 'Tutup pratonton',
  fileTooLarge: 'Fail itu lebih besar daripada {max}.',
  fileTypeNotAllowed: 'Jenis fail itu tidak boleh dihantar di sini.',
  uploadFailed: 'Muat naik gagal. Ketik untuk cuba lagi.',
  sendFailed: 'Tidak dihantar. Ketik untuk cuba lagi.',
  rateLimited: 'Anda terlalu kerap melakukannya. Sila tunggu sebentar dan cuba lagi.',
  networkError: 'Masalah rangkaian. Semak sambungan anda dan cuba lagi.',
  genericError: 'Sesuatu telah berlaku. Sila cuba lagi.',
  messageUnavailable: 'Mesej ini tidak dapat dipaparkan.',
  historyFailed: 'Tidak dapat memuatkan mesej terdahulu anda.',
  chatCrashed: 'Sembang menghadapi masalah.',

  imageAlt: 'Foto',
  videoLabel: 'Video',
  voiceMessage: 'Mesej suara',
  play: 'Main',
  pause: 'Jeda',
  download: 'Muat turun',
  openImage: 'Buka foto',

  emojiSearch: 'Cari emoji',
  emojiRecent: 'Terkini',
  emojiNone: 'Tiada emoji ditemui',
  emojiLoading: 'Memuatkan emoji…',
  emojiFailed: 'Emoji tidak dapat dimuatkan.',
  catSmileys: 'Senyuman',
  catPeople: 'Orang',
  catAnimals: 'Haiwan',
  catFood: 'Makanan',
  catTravel: 'Perjalanan',
  catActivities: 'Aktiviti',
  catObjects: 'Objek',
  catSymbols: 'Simbol',
  catFlags: 'Bendera',

  tickPending: 'Menghantar',
  tickSent: 'Dihantar',
  tickDelivered: 'Diterima',
  tickRead: 'Dibaca',
}

const zh: Dict = {
  openChat: '打开聊天',
  closeChat: '关闭聊天',
  connecting: '正在连接…',
  reconnecting: '正在重新连接…',
  retry: '重试',
  back: '返回',
  cancel: '取消',
  loadingChat: '正在加载聊天…',

  choiceTitle: '我们能为您做些什么？',
  choiceExisting: '我已是 Vircle 用户',
  choiceExistingHint: '找到您的账户，我们可以更快地为您服务。',
  choiceEnquiry: '我想咨询',
  choiceEnquiryHint: '告诉我们您是谁以及您的需求。',
  choiceGuest: '直接聊天，跳过此步',

  claimTitle: '查找您的账户',
  claimHint: '请输入您在 Vircle 使用的手机号码或电子邮箱。',
  fieldPhone: '手机号码',
  fieldPhonePh: '例如 60123456789',
  fieldEmail: '电子邮箱',
  fieldEmailPh: 'you@example.com',
  fieldName: '您的姓名',
  fieldNameOptional: '您的姓名（选填）',
  claimSubmit: '开始聊天',
  starting: '正在开始…',
  contactEither: '手机号码或电子邮箱，至少填写一项。',
  errName: '请输入您的姓名。',
  errContact: '请输入手机号码或电子邮箱。',
  errEmail: '电子邮箱格式不正确。',
  errPhone: '手机号码格式不正确。',
  errMessage: '请输入简短的留言（最多 2000 字）。',
  errConsent: '请勾选后再继续。',
  errClaim: '无法使用这些信息，请检查后重试。',

  verifyTitle: '输入验证码',
  verifyHint: '我们已将 6 位验证码发送到 {destination}，10 分钟内有效。',
  fieldCode: '验证码',
  fieldCodePh: '123456',
  errCode: '请输入我们发送给您的验证码。',
  verifying: '正在验证…',
  verifySubmit: '验证',
  resendCode: '重新发送验证码',
  useDifferentNumber: '使用其他号码',
  errVerifyCode: '验证码无效，请重试。',

  enquiryTitle: '向我们发送咨询',
  fieldRole: '我是',
  roleParent: '家长',
  roleSchool: '学校',
  roleMerchant: '商家',
  roleOther: '其他',
  fieldMessage: '您的留言',
  fieldMessagePh: '我们能帮您什么？',
  consent: '我同意 Vircle 就此咨询与我联系。',
  submitEnquiry: '发送咨询',
  enquirySent: '谢谢！我们已收到您的咨询，很快会在此回复。',

  welcomeBack: '欢迎回来，{name}！',
  welcomeBackNoName: '欢迎回来！',
  welcomeNew: '谢谢！我们会为您处理。',
  linkAccount: '已是 Vircle 用户？关联您的账户',
  linkSubmit: '关联',

  typeMessage: '输入消息',
  send: '发送',
  attach: '添加附件',
  emoji: '表情',
  voiceNote: '录制语音消息',
  recording: '正在录音…',
  stopAndSend: '停止并发送',
  cancelRecording: '放弃录音',
  micDenied: '麦克风权限被拒绝。请在浏览器中允许后再发送语音消息。',
  micUnsupported: '此浏览器不支持语音消息。',
  recordingFailed: '录音失败，请重试。',
  micSilent: '我们听不到任何声音。您的麦克风可能已静音，或选择了错误的麦克风。',
  micSilentSend: '此麦克风没有收到任何声音。仍要发送吗？',
  micChange: '更换麦克风',
  micChoose: '选择麦克风',
  micNone: '未找到麦克风。',
  micFallbackName: '麦克风 {n}',
  sendAnyway: '仍然发送',
  discard: '放弃',

  today: '今天',
  yesterday: '昨天',
  unreadOne: '1 条未读消息',
  unreadMany: '{n} 条未读消息',
  loadEarlier: '加载更早的消息',
  loadingEarlier: '加载中…',
  emptyChat: '打个招呼吧，我们随时为您服务。',

  captionPh: '添加说明…',
  sendFile: '发送',
  closePreview: '关闭预览',
  fileTooLarge: '文件超过 {max}。',
  fileTypeNotAllowed: '不能在此发送该类型的文件。',
  uploadFailed: '上传失败，点击重试。',
  sendFailed: '未发送，点击重试。',
  rateLimited: '操作过于频繁，请稍候再试。',
  networkError: '网络出现问题，请检查网络后重试。',
  genericError: '出了点问题，请重试。',
  messageUnavailable: '无法显示此消息。',
  historyFailed: '无法加载您之前的消息。',
  chatCrashed: '聊天出现问题。',

  imageAlt: '图片',
  videoLabel: '视频',
  voiceMessage: '语音消息',
  play: '播放',
  pause: '暂停',
  download: '下载',
  openImage: '查看图片',

  emojiSearch: '搜索表情',
  emojiRecent: '最近使用',
  emojiNone: '没有找到表情',
  emojiLoading: '正在加载表情…',
  emojiFailed: '无法加载表情。',
  catSmileys: '笑脸',
  catPeople: '人物',
  catAnimals: '动物',
  catFood: '食物',
  catTravel: '旅行',
  catActivities: '活动',
  catObjects: '物品',
  catSymbols: '符号',
  catFlags: '旗帜',

  tickPending: '发送中',
  tickSent: '已发送',
  tickDelivered: '已送达',
  tickRead: '已读',
}

const DICTS: Record<Locale, Dict> = { en, ms, zh }

/** Map a BCP-47-ish tag ("zh-Hans-CN", "ms_MY", "en-GB") to a supported locale. */
export function matchLocale(tag: string | null | undefined): Locale | null {
  if (!tag) return null
  const primary = tag.trim().toLowerCase().replace('_', '-').split('-')[0]
  if (primary === 'en' || primary === 'ms' || primary === 'zh') return primary
  return null
}

/**
 * Pick the widget language. The embed's `data-lang` wins (the host
 * knows its own user), then the page's `<html lang>`, then the browser
 * languages in order; English when nothing matches.
 */
export function resolveLocale(
  dataLang: string | null | undefined,
  htmlLang: string | null | undefined,
  navigatorLanguages: readonly string[] | null | undefined,
): Locale {
  const direct = matchLocale(dataLang) ?? matchLocale(htmlLang)
  if (direct) return direct
  for (const tag of navigatorLanguages ?? []) {
    const hit = matchLocale(tag)
    if (hit) return hit
  }
  return 'en'
}

export type Translate = (key: StringKey, params?: Record<string, string | number>) => string

/** Look a string up, filling `{param}` placeholders. Falls back to English. */
export function translate(
  locale: Locale,
  key: StringKey,
  params?: Record<string, string | number>,
): string {
  const raw: string = DICTS[locale]?.[key] ?? en[key] ?? key
  if (!params) return raw
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  )
}

export function makeTranslator(locale: Locale): Translate {
  return (key, params) => translate(locale, key, params)
}

/** Every key present in English, for tests that assert full coverage. */
export const ALL_KEYS = Object.keys(en) as StringKey[]
export const DICTIONARIES: Record<Locale, Record<string, string>> = DICTS
