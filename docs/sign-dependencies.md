# Doc Sign: third-party code and fonts

Checked on 6 October 2026, when the PDF engine (work package 2) was added. Nothing here is copied from
OpenSign or any other signing product; these are general-purpose libraries and fonts.

## Libraries

| Package | Version | Licence | Used for |
|---|---|---|---|
| `pdf-lib` | 1.17.1 | MIT | Reading PDFs, writing text, images and pages, saving with plain cross-reference tables |
| `@pdf-lib/fontkit` | 1.1.1 | MIT | Embedding TrueType fonts in `pdf-lib` |
| `@signpdf/signpdf` | 3.3.0 | MIT | Filling a signature placeholder with a PKCS#7 signature |
| `@signpdf/placeholder-pdf-lib` | 3.3.0 | MIT | Adding the signature placeholder through `pdf-lib` |
| `@signpdf/signer-p12` | 3.3.0 | MIT | Signing with a PKCS#12 certificate |
| `@signpdf/utils` | 3.3.0 | MIT | Constants shared by the three above |
| `node-forge` | 1.4.0 | BSD-3-Clause OR GPL-2.0 (Halo uses it under BSD-3-Clause) | Reading certificates, making a test certificate, and checking a signature in `verify.ts` |
| `qrcode` | 1.5.4 | MIT | The QR code on the certificate page |
| `sharp` (already used) | 0.35 | Apache-2.0 | Tests only: drawing a sample signature image |

Planned for later work packages, licence already checked: `pdfjs-dist` (Apache-2.0, page rendering in the
browser, WP4) and `signature_pad` (MIT, drawn signatures, WP5).

Word to PDF conversion (WP3) uses Gotenberg (MIT) in its own container, which runs LibreOffice (MPL-2.0 and
others). LibreOffice is not linked into or modified by Halo.

## Fonts (SIL Open Font Licence 1.1)

| File | Source | What was done |
|---|---|---|
| `src/lib/sign/pdf/assets/NotoSans_400Regular.ttf`, `NotoSans_700Bold.ttf` | Noto Sans, Noto Project Authors | Cut down to Latin, Latin Extended and Vietnamese, general punctuation and currency symbols; hinting removed (about 72 KB each) |
| `src/lib/sign/pdf/assets/DancingScript_400Regular.ttf` | Dancing Script, Dancing Script Project Authors | Cut down to Latin and Latin Extended (about 53 KB). Used for typed signatures |

The licences are beside the files (`*-OFL.txt`). The OFL allows cutting a font down and embedding it in a
document; the modified files are not sold on their own.

### Why the fonts are embedded whole

`pdf-lib`'s own subsetter drops most letters from these fonts: a page rendered with only "Ked Sd B d" where
"Kedai Runcit Ali Sdn Bhd" was written, while text extraction still read the full text. The engine therefore
embeds the (already small) files whole; a test (`pipeline.test.ts`) fails if that changes.

Ligatures are removed from the cut-down fonts for the same family of reason: with the `fi` ligature present,
`pdf-lib` measured text with the ligature and drew it without, leaving a gap ("Certifi cate").

### Chinese and Korean

The bundled fonts have no Chinese or Korean glyphs, and a font that has them is 10 MB or more. Until one is
provided, such a character is written as `?` and the engine reports an `unsupported_characters` warning, which
the sender sees before sending. Setting `SIGN_CJK_FONT_PATH` to a TrueType or OpenType file on the server
(for example Noto Sans CJK) makes the engine use it for any character the main font lacks. That path is
untested with a real CJK font and is to be proved before Chinese or Korean names are expected on documents
(the subsetting problem above may apply to it too, in which case the file must be embedded whole).

## Checking that a sealed file is sound

`verifySealed()` reads the signature out of the PDF itself, so it does not trust the sealing code. In
addition, the test suite has OpenSSL (`openssl cms -verify`) check the same signature, and the sealed demo
file was also checked with pyHanko, an unrelated validator: intact, cryptographically valid, covering the
entire file, certificate untrusted (it is self-signed, as the test certificate is).
