-- ============================================================
-- 194_compliance_fraud_review.sql
--
-- Compliance requests: a new request type, TRANSACTION FRAUD REVIEW (key `fraud_review`). A customer, or a member of staff, reports a transaction the customer says
-- is fraud; the case records every detail, the customer's screenshots, the investigation results and the action taken, and goes through the same nine steps
-- as every other case (identity check, officer review, the Head of Compliance's sign-off, the operations checklist, closed), with the same maker-checker rule
-- and the same seven-year trail.
--
--   * It is an ORDINARY (not a system) type: an administrator can edit its fields, steps and clocks in Settings, switch it off, or delete it. 183's three
--     system types stay fixed. Nothing about the case, the screens or the functions changes: a type is data.
--   * Details are asked when the case is raised: the kind of fraud, the transaction reference, date and amount, the customer's wallet, the recipient (the
--     recipient's account is SENSITIVE: stored encrypted, shown masked, revealed only with compliance.reveal and logged), what happened, a police report
--     number, and the customer's screenshots (a file field: JPEG, PNG or PDF, 10 MB each, uploaded in the case).
--   * The investigation fields (results, outcome, amount recovered, action taken, evidence files) are NOT required: the officer fills them in while the case is
--     in review. Like every answer they are frozen once the case is with the Head of Compliance (so the person signing off signs what they saw).
--   * The actions after approval are the checklist: preserve the evidence, block or restrict the account, recall the funds, report, tell the customer. Each tick
--     is stamped with who and when, and can carry a note.
--   * Clocks: a target of 7 days and a hard stop of 30, set on each case when it is created. These are a starting point, not a legal opinion: an administrator
--     changes them in Settings (new cases only).
--
-- compliance_fraud_review_type() never overwrites: a type that exists (edited, or deactivated by an administrator) is left as it is. The workspaces that exist
-- now get the type here, and a workspace made from now on gets it from compliance_accounts_seed(), which is 186's with one more line.
--
-- No new table, policy, grant or capability. The function is service-role only (REVOKEd from everyone else), like 183's seed. Apply BEFORE the code that
-- goes with it is deployed (this release has none: the type is data). Idempotent.
-- ============================================================

CREATE OR REPLACE FUNCTION public.compliance_fraud_review_type(p_account UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.compliance_request_types
    (account_id, key, label, label_l10n, fields, checklist, target_days, hard_stop_days, requires_identity_check, check_dues, allow_pause, is_system, position)
  VALUES
    (p_account, 'fraud_review', 'Transaction fraud review',
     jsonb_build_object('ms', 'Semakan penipuan transaksi', 'zh', '交易欺诈审查', 'ko', '거래 사기 검토'),
     jsonb_build_array(
       -- The report
       jsonb_build_object('key', 'fraud_kind', 'type', 'choice', 'required', true, 'sensitive', false,
         'label', public.compliance_label('Kind of fraud', 'Jenis penipuan', '欺诈类型', '사기 유형'),
         'options', jsonb_build_array(
           jsonb_build_object('value', 'unauthorised',
             'label', public.compliance_label('Unauthorised transaction (the customer did not make it)', 'Transaksi tanpa kebenaran (pelanggan tidak membuatnya)', '未经授权的交易（客户并未操作）', '무단 거래(고객이 직접 하지 않음)')),
           jsonb_build_object('value', 'scam',
             'label', public.compliance_label('The customer was deceived into paying', 'Pelanggan diperdaya untuk membuat bayaran', '客户被骗而付款', '고객이 속아서 결제함')),
           jsonb_build_object('value', 'takeover',
             'label', public.compliance_label('Account taken over', 'Akaun diambil alih', '账户被盗用', '계정 탈취')),
           jsonb_build_object('value', 'wrong_recipient',
             'label', public.compliance_label('Money sent to the wrong recipient', 'Wang dihantar kepada penerima yang salah', '款项汇给了错误的收款人', '잘못된 수취인에게 송금됨')),
           jsonb_build_object('value', 'other',
             'label', public.compliance_label('Other', 'Lain-lain', '其他', '기타')))),
       jsonb_build_object('key', 'transaction_ref', 'type', 'text', 'required', true, 'sensitive', false,
         'label', public.compliance_label('Transaction reference or ID', 'Rujukan atau ID transaksi', '交易参考编号或ID', '거래 참조 번호 또는 ID')),
       jsonb_build_object('key', 'transaction_date', 'type', 'date', 'required', true, 'sensitive', false,
         'label', public.compliance_label('Date of the transaction', 'Tarikh transaksi', '交易日期', '거래 날짜')),
       jsonb_build_object('key', 'amount', 'type', 'number', 'required', true, 'sensitive', false,
         'label', public.compliance_label('Amount (RM)', 'Jumlah (RM)', '金额（令吉）', '금액(RM)')),
       jsonb_build_object('key', 'customer_wallet_id', 'type', 'text', 'required', false, 'sensitive', false,
         'label', public.compliance_label('Customer wallet ID', 'ID dompet pelanggan', '客户钱包ID', '고객 지갑 ID')),
       jsonb_build_object('key', 'recipient_name', 'type', 'text', 'required', false, 'sensitive', false,
         'label', public.compliance_label('Recipient or merchant name', 'Nama penerima atau peniaga', '收款人或商户名称', '수취인 또는 가맹점 이름')),
       jsonb_build_object('key', 'recipient_account', 'type', 'text', 'required', false, 'sensitive', true,
         'label', public.compliance_label('Recipient account, wallet or phone number', 'Akaun, dompet atau nombor telefon penerima', '收款人的账户、钱包或手机号码', '수취인 계좌, 지갑 또는 전화번호')),
       jsonb_build_object('key', 'description', 'type', 'multiline', 'required', true, 'sensitive', false,
         'label', public.compliance_label('What happened (in the customer''s own words)', 'Apa yang berlaku (dengan kata-kata pelanggan sendiri)', '事情经过（用客户自己的话）', '경위(고객 본인의 표현으로)')),
       jsonb_build_object('key', 'police_report', 'type', 'text', 'required', false, 'sensitive', false,
         'label', public.compliance_label('Police report number, if any', 'Nombor laporan polis, jika ada', '警方报案编号（如有）', '경찰 신고 번호(있는 경우)')),
       jsonb_build_object('key', 'screenshots', 'type', 'file', 'required', false, 'sensitive', false,
         'label', public.compliance_label('Screenshots and proof from the customer', 'Tangkapan skrin dan bukti daripada pelanggan', '客户提供的截图和证明', '고객이 제공한 스크린샷 및 증빙'),
         'help', public.compliance_label('Attach what the customer sent: JPEG, PNG or PDF, up to 10 MB each.', 'Lampirkan apa yang dihantar pelanggan: JPEG, PNG atau PDF, sehingga 10 MB setiap satu.', '附上客户发送的文件：JPEG、PNG 或 PDF，每个最大 10 MB。', '고객이 보낸 파일을 첨부하세요: JPEG, PNG 또는 PDF, 파일당 최대 10 MB.')),
       -- The investigation (filled in by the officer while the case is in review)
       jsonb_build_object('key', 'investigation_findings', 'type', 'multiline', 'required', false, 'sensitive', false,
         'label', public.compliance_label('Investigation results', 'Keputusan siasatan', '调查结果', '조사 결과'),
         'help', public.compliance_label('Filled in by the investigating officer while the case is in review. It is frozen once the case goes to the Head of Compliance.', 'Diisi oleh pegawai penyiasat semasa kes dalam semakan. Ia dibekukan apabila kes dihantar kepada Ketua Pematuhan.', '由调查人员在案件审查期间填写。案件提交合规主管后即被锁定。', '사건이 검토 중일 때 조사 담당자가 작성합니다. 사건이 준법 책임자에게 넘어가면 수정할 수 없습니다.')),
       jsonb_build_object('key', 'investigation_outcome', 'type', 'choice', 'required', false, 'sensitive', false,
         'label', public.compliance_label('Outcome of the investigation', 'Hasil siasatan', '调查结论', '조사 결론'),
         'options', jsonb_build_array(
           jsonb_build_object('value', 'fraud_confirmed',
             'label', public.compliance_label('Fraud confirmed', 'Penipuan disahkan', '确认为欺诈', '사기 확인됨')),
           jsonb_build_object('value', 'not_fraud',
             'label', public.compliance_label('Not fraud (a genuine transaction)', 'Bukan penipuan (transaksi sah)', '非欺诈（正常交易）', '사기 아님(정상 거래)')),
           jsonb_build_object('value', 'inconclusive',
             'label', public.compliance_label('Inconclusive', 'Tidak muktamad', '尚无定论', '결론 없음')))),
       jsonb_build_object('key', 'amount_recovered', 'type', 'number', 'required', false, 'sensitive', false,
         'label', public.compliance_label('Amount recovered (RM)', 'Jumlah dipulihkan (RM)', '追回金额（令吉）', '회수 금액(RM)')),
       jsonb_build_object('key', 'action_taken', 'type', 'multiline', 'required', false, 'sensitive', false,
         'label', public.compliance_label('Action taken or recommended', 'Tindakan yang diambil atau disyorkan', '已采取或建议的措施', '조치 내용 또는 권고')),
       jsonb_build_object('key', 'investigation_files', 'type', 'file', 'required', false, 'sensitive', false,
         'label', public.compliance_label('Investigation evidence (logs, exports, correspondence)', 'Bukti siasatan (log, eksport, surat-menyurat)', '调查证据（日志、导出文件、往来函件）', '조사 증거(로그, 내보내기, 서신)'))
     ),
     jsonb_build_array(
       jsonb_build_object('key', 'preserve_evidence', 'label', public.compliance_label('Preserve the transaction logs and evidence', 'Simpan log transaksi dan bukti', '保存交易日志和证据', '거래 로그와 증거 보존')),
       jsonb_build_object('key', 'restrict_account', 'label', public.compliance_label('Block or restrict the affected account or wallet, if needed', 'Sekat atau hadkan akaun atau dompet yang terjejas, jika perlu', '如有需要，冻结或限制受影响的账户或钱包', '필요 시 영향받은 계정 또는 지갑 차단 또는 제한')),
       jsonb_build_object('key', 'recall_funds', 'label', public.compliance_label('Ask the bank or recipient to recall the funds, or reverse the transaction', 'Minta bank atau penerima menarik balik dana, atau batalkan transaksi', '请银行或收款人追回资金，或撤销交易', '은행 또는 수취인에게 자금 회수 요청 또는 거래 취소')),
       jsonb_build_object('key', 'report_authorities', 'label', public.compliance_label('Report to the authorities or the bank, if required', 'Laporkan kepada pihak berkuasa atau bank, jika perlu', '如有需要，向主管机关或银行报告', '필요 시 당국 또는 은행에 신고')),
       jsonb_build_object('key', 'confirm_customer', 'label', public.compliance_label('Tell the customer the outcome and give security advice', 'Maklumkan pelanggan hasilnya dan beri nasihat keselamatan', '告知客户结果并提供安全建议', '고객에게 결과를 안내하고 보안 조언 제공'))
     ),
     7, 30, TRUE, FALSE, FALSE, FALSE, 4)
  ON CONFLICT (account_id, key) DO NOTHING;
END;
$$;
ALTER FUNCTION public.compliance_fraud_review_type(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_fraud_review_type(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_fraud_review_type(UUID) TO service_role;

-- A workspace made from now on gets the three types, 184's intake fields, 185's account change fields, 186's question and this type. Never blocks signup.
CREATE OR REPLACE FUNCTION public.compliance_accounts_seed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.compliance_seed_types(NEW.id);
  PERFORM public.compliance_intake_fields(NEW.id);
  PERFORM public.compliance_account_change_fields(NEW.id);
  PERFORM public.compliance_bank_own_fields(NEW.id);
  PERFORM public.compliance_fraud_review_type(NEW.id);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'compliance_accounts_seed failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.compliance_accounts_seed() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_accounts_seed() FROM PUBLIC, anon, authenticated;

-- the workspaces that exist now
DO $$
BEGIN
  PERFORM public.compliance_fraud_review_type(a.id) FROM public.accounts a;
END $$;
