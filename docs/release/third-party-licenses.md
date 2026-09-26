# 第三方依赖许可证清单

生成方式：`node scripts/release/third-party-licenses.mjs`（本机 `cargo metadata --offline --locked` 与 `package-lock.json`，不联网）。依赖锁文件最后修改提交：`e8cbe09ec7c7`。

范围：随产品分发的依赖。Rust 为 `oris`（desktop 特性）的 normal 依赖传递闭包，按 Windows（x86_64-pc-windows-gnu）与 macOS（aarch64-apple-darwin）分别解析；npm 为 `dependencies` 的传递闭包（打包进前端资源）。构建工具（Tauri CLI、Vite、TypeScript、测试框架）、build / dev 依赖不随产品分发，不在此列。许可证字段取自各包自己的元数据，未逐包复核源码。

配色方案数据来自 VS Code 与 Colorsublime-Themes（MIT），声明见 `src/themes/generated/NOTICES.txt`，同时显示在设置 → 外观，并收入安装包的 `THIRD-PARTY-NOTICES.txt`。

合计：Cargo 288 个包（Windows 265、macOS 259），npm 25 个包。

## 按许可证汇总

| 生态 | 许可证（SPDX 表达式） | 包数 |
| --- | --- | --- |
| Cargo | MIT OR Apache-2.0 | 140 |
| Cargo | MIT | 43 |
| Cargo | Apache-2.0 OR MIT | 26 |
| npm | MIT | 23 |
| Cargo | Unicode-3.0 | 18 |
| Cargo | MIT/Apache-2.0 | 14 |
| Cargo | Unlicense OR MIT | 11 |
| Cargo | Zlib OR Apache-2.0 OR MIT | 9 |
| Cargo | MPL-2.0 | 5 |
| Cargo | MIT OR Apache-2.0 OR Zlib | 3 |
| Cargo | BSD-3-Clause | 2 |
| Cargo | Zlib | 2 |
| Cargo | MIT OR Zlib OR Apache-2.0 | 2 |
| Cargo | BSD-3-Clause OR Apache-2.0 | 2 |
| Cargo | Unlicense/MIT | 2 |
| Cargo | 0BSD OR MIT OR Apache-2.0 | 1 |
| Cargo | BSD-3-Clause AND MIT | 1 |
| Cargo | BSD-3-Clause/MIT | 1 |
| Cargo | Apache-2.0 AND MIT | 1 |
| Cargo | CC0-1.0 OR MIT-0 OR Apache-2.0 | 1 |
| Cargo | Apache-2.0 / MIT | 1 |
| Cargo | CC0-1.0 | 1 |
| Cargo | Apache-2.0 | 1 |
| Cargo | (MIT OR Apache-2.0) AND Unicode-3.0 | 1 |
| npm | Apache-2.0 OR MIT | 1 |
| npm | MIT OR Apache-2.0 | 1 |

## 需要留意

以下包的许可证表达式中没有可单独选用的宽松许可（MIT / Apache-2.0 / BSD / ISC / Zlib 等），公开发布前需人工确认义务：

| 生态 | 包 | 版本 | 许可证 |
| --- | --- | --- | --- |
| Cargo | cssparser | 0.36.0 | MPL-2.0 |
| Cargo | cssparser-macros | 0.6.1 | MPL-2.0 |
| Cargo | dtoa-short | 0.3.5 | MPL-2.0 |
| Cargo | option-ext | 0.2.0 | MPL-2.0 |
| Cargo | selectors | 0.36.1 | MPL-2.0 |

以下 22 个包的源码目录中没有 LICENSE / NOTICE 文件，NOTICES 中只列出许可证名称：

alloc-stdlib 0.2.4（BSD-3-Clause）、block2 0.6.2（MIT）、defmt-parser 1.0.0（MIT OR Apache-2.0）、dispatch2 0.3.1（Zlib OR Apache-2.0 OR MIT）、objc2 0.6.4（MIT）、objc2-app-kit 0.3.2（Zlib OR Apache-2.0 OR MIT）、objc2-core-foundation 0.3.2（Zlib OR Apache-2.0 OR MIT）、objc2-core-graphics 0.3.2（Zlib OR Apache-2.0 OR MIT）、objc2-encode 4.1.0（MIT）、objc2-exception-helper 0.1.1（Zlib OR Apache-2.0 OR MIT）、objc2-foundation 0.3.2（MIT）、objc2-io-surface 0.3.2（Zlib OR Apache-2.0 OR MIT）、objc2-web-kit 0.3.2（Zlib OR Apache-2.0 OR MIT）、selectors 0.36.1（MPL-2.0）、unic-char-property 0.9.0（MIT/Apache-2.0）、unic-char-range 0.9.0（MIT/Apache-2.0）、unic-common 0.9.0（MIT/Apache-2.0）、unic-ucd-ident 0.9.0（MIT/Apache-2.0）、unic-ucd-version 0.9.0（MIT/Apache-2.0）、webview2-com 0.38.2（MIT）、webview2-com-macros 0.8.1（MIT）、webview2-com-sys 0.38.2（MIT）

## 完整清单

| 生态 | 包 | 版本 | 许可证 | 平台 | 来源 |
| --- | --- | --- | --- | --- | --- |
| Cargo | adler2 | 2.0.1 | 0BSD OR MIT OR Apache-2.0 | windows / macos | https://github.com/oyvindln/adler2 |
| Cargo | aho-corasick | 1.1.5 | Unlicense OR MIT | windows / macos | https://github.com/BurntSushi/aho-corasick |
| Cargo | alloc-no-stdlib | 2.0.4 | BSD-3-Clause | windows / macos | https://github.com/dropbox/rust-alloc-no-stdlib |
| Cargo | alloc-stdlib | 0.2.4 | BSD-3-Clause | windows / macos | https://github.com/dropbox/rust-alloc-no-stdlib |
| Cargo | anyhow | 1.0.104 | MIT OR Apache-2.0 | windows / macos | https://github.com/dtolnay/anyhow |
| Cargo | base64 | 0.21.7 | MIT OR Apache-2.0 | macos | https://github.com/marshallpierce/rust-base64 |
| Cargo | base64 | 0.22.1 | MIT OR Apache-2.0 | windows / macos | https://github.com/marshallpierce/rust-base64 |
| Cargo | base64 | 0.23.1 | MIT OR Apache-2.0 | windows / macos | https://github.com/marshallpierce/rust-base64 |
| Cargo | bit-set | 0.8.0 | Apache-2.0 OR MIT | windows / macos | https://github.com/contain-rs/bit-set |
| Cargo | bit-vec | 0.8.0 | Apache-2.0 OR MIT | windows / macos | https://github.com/contain-rs/bit-vec |
| Cargo | bitflags | 1.3.2 | MIT/Apache-2.0 | windows / macos | https://github.com/bitflags/bitflags |
| Cargo | bitflags | 2.13.2 | MIT OR Apache-2.0 | windows / macos | https://github.com/bitflags/bitflags |
| Cargo | block-buffer | 0.10.4 | MIT OR Apache-2.0 | windows / macos | https://github.com/RustCrypto/utils |
| Cargo | block2 | 0.6.2 | MIT | macos | https://github.com/madsmtm/objc2 |
| Cargo | brotli | 8.0.4 | BSD-3-Clause AND MIT | windows / macos | https://github.com/dropbox/rust-brotli |
| Cargo | brotli-decompressor | 5.0.3 | BSD-3-Clause/MIT | windows / macos | https://github.com/dropbox/rust-brotli-decompressor |
| Cargo | bs58 | 0.5.1 | MIT/Apache-2.0 | windows / macos | https://github.com/Nullus157/bs58-rs |
| Cargo | bstr | 1.13.1 | MIT OR Apache-2.0 | windows / macos | https://github.com/BurntSushi/bstr |
| Cargo | bytemuck | 1.25.2 | Zlib OR Apache-2.0 OR MIT | windows / macos | https://github.com/Lokathor/bytemuck |
| Cargo | byteorder | 1.5.0 | Unlicense OR MIT | windows / macos | https://github.com/BurntSushi/byteorder |
| Cargo | byteorder-lite | 0.1.0 | Unlicense OR MIT | windows / macos | https://github.com/image-rs/byteorder-lite |
| Cargo | bytes | 1.12.1 | MIT | windows / macos | https://github.com/tokio-rs/bytes |
| Cargo | camino | 1.2.6 | MIT OR Apache-2.0 | windows / macos | https://github.com/camino-rs/camino |
| Cargo | cargo_metadata | 0.19.2 | MIT | windows / macos | https://github.com/oli-obk/cargo_metadata |
| Cargo | cargo-platform | 0.1.9 | MIT OR Apache-2.0 | windows / macos | https://github.com/rust-lang/cargo |
| Cargo | cfb | 0.7.3 | MIT | windows / macos | https://github.com/mdsteele/rust-cfb |
| Cargo | cfg-if | 1.0.5 | MIT OR Apache-2.0 | windows / macos | https://github.com/rust-lang/cfg-if |
| Cargo | chrono | 0.4.45 | MIT OR Apache-2.0 | windows / macos | https://github.com/chronotope/chrono |
| Cargo | cookie | 0.18.2 | MIT OR Apache-2.0 | windows / macos | https://github.com/SergioBenitez/cookie-rs |
| Cargo | core-foundation | 0.10.1 | MIT OR Apache-2.0 | macos | https://github.com/servo/core-foundation-rs |
| Cargo | core-foundation-sys | 0.8.7 | MIT OR Apache-2.0 | macos | https://github.com/servo/core-foundation-rs |
| Cargo | core-graphics | 0.25.0 | MIT OR Apache-2.0 | macos | https://github.com/servo/core-foundation-rs |
| Cargo | core-graphics-types | 0.2.0 | MIT OR Apache-2.0 | macos | https://github.com/servo/core-foundation-rs |
| Cargo | cpufeatures | 0.2.17 | MIT OR Apache-2.0 | windows / macos | https://github.com/RustCrypto/utils |
| Cargo | crc32fast | 1.5.2 | MIT OR Apache-2.0 | windows / macos | https://github.com/srijs/rust-crc32fast |
| Cargo | crossbeam-channel | 0.5.17 | MIT OR Apache-2.0 | windows / macos | https://github.com/crossbeam-rs/crossbeam |
| Cargo | crossbeam-deque | 0.8.8 | MIT OR Apache-2.0 | windows / macos | https://github.com/crossbeam-rs/crossbeam |
| Cargo | crossbeam-epoch | 0.9.21 | MIT OR Apache-2.0 | windows / macos | https://github.com/crossbeam-rs/crossbeam |
| Cargo | crossbeam-utils | 0.8.23 | MIT OR Apache-2.0 | windows / macos | https://github.com/crossbeam-rs/crossbeam |
| Cargo | crypto-common | 0.1.7 | MIT OR Apache-2.0 | windows / macos | https://github.com/RustCrypto/traits |
| Cargo | cssparser | 0.36.0 | MPL-2.0 | windows / macos | https://github.com/servo/rust-cssparser |
| Cargo | cssparser-macros | 0.6.1 | MPL-2.0 | windows / macos | https://github.com/servo/rust-cssparser |
| Cargo | ctor | 0.8.0 | Apache-2.0 OR MIT | windows / macos | https://github.com/mmastrac/rust-ctor |
| Cargo | ctor-proc-macro | 0.0.7 | Apache-2.0 OR MIT | windows / macos | https://github.com/mmastrac/rust-ctor |
| Cargo | darling | 0.24.1 | MIT | windows / macos | https://github.com/TedDriggs/darling |
| Cargo | darling_core | 0.24.1 | MIT | windows / macos | https://github.com/TedDriggs/darling |
| Cargo | darling_macro | 0.24.1 | MIT | windows / macos | https://github.com/TedDriggs/darling |
| Cargo | defmt | 1.1.1 | MIT OR Apache-2.0 | windows / macos | https://github.com/knurling-rs/defmt |
| Cargo | defmt-macros | 1.1.1 | MIT OR Apache-2.0 | windows / macos | https://github.com/knurling-rs/defmt |
| Cargo | defmt-parser | 1.0.0 | MIT OR Apache-2.0 | windows / macos | https://github.com/knurling-rs/defmt |
| Cargo | deranged | 0.5.8 | MIT OR Apache-2.0 | windows / macos | https://github.com/jhpratt/deranged |
| Cargo | derive_more | 2.1.1 | MIT | windows / macos | https://github.com/JelteF/derive_more |
| Cargo | derive_more-impl | 2.1.1 | MIT | windows / macos | https://github.com/JelteF/derive_more |
| Cargo | digest | 0.10.7 | MIT OR Apache-2.0 | windows / macos | https://github.com/RustCrypto/traits |
| Cargo | dirs | 6.0.0 | MIT OR Apache-2.0 | windows / macos | https://github.com/soc/dirs-rs |
| Cargo | dirs-sys | 0.5.0 | MIT OR Apache-2.0 | windows / macos | https://github.com/dirs-dev/dirs-sys-rs |
| Cargo | dispatch2 | 0.3.1 | Zlib OR Apache-2.0 OR MIT | macos | https://github.com/madsmtm/objc2 |
| Cargo | displaydoc | 0.2.7 | MIT OR Apache-2.0 | windows / macos | https://github.com/yaahc/displaydoc |
| Cargo | dom_query | 0.27.0 | MIT | windows / macos | https://github.com/niklak/dom_query |
| Cargo | dpi | 0.1.2 | Apache-2.0 AND MIT | windows / macos | https://github.com/rust-windowing/winit |
| Cargo | dtoa | 1.0.11 | MIT OR Apache-2.0 | windows / macos | https://github.com/dtolnay/dtoa |
| Cargo | dtoa-short | 0.3.5 | MPL-2.0 | windows / macos | https://github.com/upsuper/dtoa-short |
| Cargo | dtor | 0.3.0 | Apache-2.0 OR MIT | windows / macos | https://github.com/mmastrac/rust-ctor |
| Cargo | dtor-proc-macro | 0.0.6 | Apache-2.0 OR MIT | windows / macos | https://github.com/mmastrac/rust-ctor |
| Cargo | dunce | 1.0.5 | CC0-1.0 OR MIT-0 OR Apache-2.0 | windows / macos | https://gitlab.com/kornelski/dunce |
| Cargo | dyn-clone | 1.0.20 | MIT OR Apache-2.0 | windows / macos | https://github.com/dtolnay/dyn-clone |
| Cargo | embed_plist | 1.2.2 | MIT OR Apache-2.0 | macos | https://github.com/nvzqz/embed-plist-rs |
| Cargo | equivalent | 1.0.2 | Apache-2.0 OR MIT | windows / macos | https://github.com/indexmap-rs/equivalent |
| Cargo | erased-serde | 0.4.10 | MIT OR Apache-2.0 | windows / macos | https://github.com/dtolnay/erased-serde |
| Cargo | fastrand | 2.5.0 | Apache-2.0 OR MIT | windows / macos | https://github.com/smol-rs/fastrand |
| Cargo | fdeflate | 0.3.7 | MIT OR Apache-2.0 | windows / macos | https://github.com/image-rs/fdeflate |
| Cargo | file-id | 0.2.3 | MIT OR Apache-2.0 | windows / macos | https://github.com/notify-rs/notify.git |
| Cargo | flate2 | 1.1.10 | MIT OR Apache-2.0 | windows / macos | https://github.com/rust-lang/flate2-rs |
| Cargo | fnv | 1.0.7 | Apache-2.0 / MIT | windows / macos | https://github.com/servo/rust-fnv |
| Cargo | foldhash | 0.2.0 | Zlib | windows / macos | https://github.com/orlp/foldhash |
| Cargo | foreign-types | 0.5.0 | MIT/Apache-2.0 | macos | https://github.com/sfackler/foreign-types |
| Cargo | foreign-types-macros | 0.2.4 | MIT/Apache-2.0 | macos | https://github.com/sfackler/foreign-types |
| Cargo | foreign-types-shared | 0.3.1 | MIT/Apache-2.0 | macos | https://github.com/sfackler/foreign-types |
| Cargo | form_urlencoded | 1.2.2 | MIT OR Apache-2.0 | windows / macos | https://github.com/servo/rust-url |
| Cargo | fsevent-sys | 4.1.0 | MIT | macos | https://github.com/octplane/fsevent-rust/tree/master/fsevent-sys |
| Cargo | generic-array | 0.14.7 | MIT | windows / macos | https://github.com/fizyk20/generic-array.git |
| Cargo | getrandom | 0.3.4 | MIT OR Apache-2.0 | windows / macos | https://github.com/rust-random/getrandom |
| Cargo | getrandom | 0.4.3 | MIT OR Apache-2.0 | windows / macos | https://github.com/rust-random/getrandom |
| Cargo | glob | 0.3.4 | MIT OR Apache-2.0 | windows / macos | https://github.com/rust-lang/glob |
| Cargo | globset | 0.4.20 | Unlicense OR MIT | windows / macos | https://github.com/BurntSushi/ripgrep/tree/master/crates/globset |
| Cargo | hashbrown | 0.12.3 | MIT OR Apache-2.0 | windows / macos | https://github.com/rust-lang/hashbrown |
| Cargo | hashbrown | 0.17.1 | MIT OR Apache-2.0 | windows / macos | https://github.com/rust-lang/hashbrown |
| Cargo | heck | 0.5.0 | MIT OR Apache-2.0 | windows / macos | https://github.com/withoutboats/heck |
| Cargo | hex | 0.4.3 | MIT OR Apache-2.0 | windows / macos | https://github.com/KokaKiwi/rust-hex |
| Cargo | html5ever | 0.38.0 | MIT OR Apache-2.0 | windows / macos | https://github.com/servo/html5ever |
| Cargo | http | 1.5.0 | MIT OR Apache-2.0 | windows / macos | https://github.com/hyperium/http |
| Cargo | iana-time-zone | 0.1.65 | MIT OR Apache-2.0 | macos | https://github.com/strawlab/iana-time-zone |
| Cargo | ico | 0.5.0 | MIT | windows / macos | https://github.com/mdsteele/rust-ico |
| Cargo | icu_collections | 2.3.0 | Unicode-3.0 | windows / macos | https://github.com/unicode-org/icu4x |
| Cargo | icu_locale_core | 2.3.0 | Unicode-3.0 | windows / macos | https://github.com/unicode-org/icu4x |
| Cargo | icu_normalizer | 2.3.0 | Unicode-3.0 | windows / macos | https://github.com/unicode-org/icu4x |
| Cargo | icu_normalizer_data | 2.3.0 | Unicode-3.0 | windows / macos | https://github.com/unicode-org/icu4x |
| Cargo | icu_properties | 2.3.0 | Unicode-3.0 | windows / macos | https://github.com/unicode-org/icu4x |
| Cargo | icu_properties_data | 2.3.0 | Unicode-3.0 | windows / macos | https://github.com/unicode-org/icu4x |
| Cargo | icu_provider | 2.3.1 | Unicode-3.0 | windows / macos | https://github.com/unicode-org/icu4x |
| Cargo | ident_case | 1.0.1 | MIT/Apache-2.0 | windows / macos | https://github.com/TedDriggs/ident_case |
| Cargo | idna | 1.1.0 | MIT OR Apache-2.0 | windows / macos | https://github.com/servo/rust-url/ |
| Cargo | idna_adapter | 1.2.2 | Apache-2.0 OR MIT | windows / macos | https://github.com/hsivonen/idna_adapter |
| Cargo | ignore | 0.4.33 | Unlicense OR MIT | windows / macos | https://github.com/BurntSushi/ripgrep/tree/master/crates/ignore |
| Cargo | image | 0.25.10 | MIT OR Apache-2.0 | windows / macos | https://github.com/image-rs/image |
| Cargo | image-webp | 0.2.4 | MIT OR Apache-2.0 | windows / macos | https://github.com/image-rs/image-webp |
| Cargo | indexmap | 1.9.3 | Apache-2.0 OR MIT | windows / macos | https://github.com/bluss/indexmap |
| Cargo | indexmap | 2.14.2 | Apache-2.0 OR MIT | windows / macos | https://github.com/indexmap-rs/indexmap |
| Cargo | infer | 0.19.0 | MIT | windows / macos | https://github.com/bojand/infer |
| Cargo | itoa | 1.0.18 | MIT OR Apache-2.0 | windows / macos | https://github.com/dtolnay/itoa |
| Cargo | jiff | 0.2.37 | Unlicense OR MIT | windows / macos | https://github.com/BurntSushi/jiff |
| Cargo | jiff-core | 0.1.1 | Unlicense OR MIT | windows / macos | https://github.com/BurntSushi/jiff |
| Cargo | jiff-tzdb | 0.1.8 | Unlicense OR MIT | windows | https://github.com/BurntSushi/jiff |
| Cargo | jiff-tzdb-platform | 0.1.3 | Unlicense OR MIT | windows | https://github.com/BurntSushi/jiff |
| Cargo | json-patch | 3.0.1 | MIT/Apache-2.0 | windows / macos | https://github.com/idubrov/json-patch |
| Cargo | jsonptr | 0.6.3 | MIT OR Apache-2.0 | windows / macos | https://github.com/chanced/jsonptr |
| Cargo | keyboard-types | 0.7.0 | MIT OR Apache-2.0 | windows / macos | https://github.com/pyfisch/keyboard-types |
| Cargo | libc | 0.2.189 | MIT OR Apache-2.0 | windows / macos | https://github.com/rust-lang/libc |
| Cargo | litemap | 0.8.3 | Unicode-3.0 | windows / macos | https://github.com/unicode-org/icu4x |
| Cargo | lock_api | 0.4.14 | MIT OR Apache-2.0 | windows / macos | https://github.com/Amanieu/parking_lot |
| Cargo | log | 0.4.34 | MIT OR Apache-2.0 | windows / macos | https://github.com/rust-lang/log |
| Cargo | markup5ever | 0.38.0 | MIT OR Apache-2.0 | windows / macos | https://github.com/servo/html5ever |
| Cargo | memchr | 2.8.3 | Unlicense OR MIT | windows / macos | https://github.com/BurntSushi/memchr |
| Cargo | mime | 0.3.17 | MIT OR Apache-2.0 | windows / macos | https://github.com/hyperium/mime |
| Cargo | miniz_oxide | 0.8.9 | MIT OR Zlib OR Apache-2.0 | windows / macos | https://github.com/Frommi/miniz_oxide/tree/master/miniz_oxide |
| Cargo | miniz_oxide | 0.9.1 | MIT OR Zlib OR Apache-2.0 | windows / macos | https://github.com/Frommi/miniz_oxide/tree/master/miniz_oxide |
| Cargo | mio | 1.2.3 | MIT | windows / macos | https://github.com/tokio-rs/mio |
| Cargo | moxcms | 0.8.1 | BSD-3-Clause OR Apache-2.0 | windows / macos | https://github.com/awxkee/moxcms.git |
| Cargo | muda | 0.19.3 | Apache-2.0 OR MIT | windows / macos | https://github.com/tauri-apps/muda |
| Cargo | new_debug_unreachable | 1.0.6 | MIT | windows / macos | https://github.com/mbrubeck/rust-debug-unreachable |
| Cargo | notify | 8.2.0 | CC0-1.0 | windows / macos | https://github.com/notify-rs/notify.git |
| Cargo | notify-debouncer-full | 0.6.0 | MIT OR Apache-2.0 | windows / macos | https://github.com/notify-rs/notify.git |
| Cargo | notify-types | 2.1.0 | MIT OR Apache-2.0 | windows / macos | https://github.com/notify-rs/notify.git |
| Cargo | num-conv | 0.2.2 | MIT OR Apache-2.0 | windows / macos | https://github.com/jhpratt/num-conv |
| Cargo | num-traits | 0.2.19 | MIT OR Apache-2.0 | windows / macos | https://github.com/rust-num/num-traits |
| Cargo | objc2 | 0.6.4 | MIT | macos | https://github.com/madsmtm/objc2 |
| Cargo | objc2-app-kit | 0.3.2 | Zlib OR Apache-2.0 OR MIT | macos | https://github.com/madsmtm/objc2 |
| Cargo | objc2-core-foundation | 0.3.2 | Zlib OR Apache-2.0 OR MIT | macos | https://github.com/madsmtm/objc2 |
| Cargo | objc2-core-graphics | 0.3.2 | Zlib OR Apache-2.0 OR MIT | macos | https://github.com/madsmtm/objc2 |
| Cargo | objc2-encode | 4.1.0 | MIT | macos | https://github.com/madsmtm/objc2 |
| Cargo | objc2-exception-helper | 0.1.1 | Zlib OR Apache-2.0 OR MIT | macos | https://github.com/madsmtm/objc2 |
| Cargo | objc2-foundation | 0.3.2 | MIT | macos | https://github.com/madsmtm/objc2 |
| Cargo | objc2-io-surface | 0.3.2 | Zlib OR Apache-2.0 OR MIT | macos | https://github.com/madsmtm/objc2 |
| Cargo | objc2-web-kit | 0.3.2 | Zlib OR Apache-2.0 OR MIT | macos | https://github.com/madsmtm/objc2 |
| Cargo | once_cell | 1.21.4 | MIT OR Apache-2.0 | windows / macos | https://github.com/matklad/once_cell |
| Cargo | option-ext | 0.2.0 | MPL-2.0 | windows / macos | https://github.com/soc/option-ext.git |
| Cargo | parking_lot | 0.12.5 | MIT OR Apache-2.0 | windows / macos | https://github.com/Amanieu/parking_lot |
| Cargo | parking_lot_core | 0.9.12 | MIT OR Apache-2.0 | windows / macos | https://github.com/Amanieu/parking_lot |
| Cargo | percent-encoding | 2.3.2 | MIT OR Apache-2.0 | windows / macos | https://github.com/servo/rust-url/ |
| Cargo | phf | 0.13.1 | MIT | windows / macos | https://github.com/rust-phf/rust-phf |
| Cargo | phf_generator | 0.13.1 | MIT | windows / macos | https://github.com/rust-phf/rust-phf |
| Cargo | phf_macros | 0.13.1 | MIT | windows / macos | https://github.com/rust-phf/rust-phf |
| Cargo | phf_shared | 0.13.1 | MIT | windows / macos | https://github.com/rust-phf/rust-phf |
| Cargo | pin-project-lite | 0.2.17 | Apache-2.0 OR MIT | windows / macos | https://github.com/taiki-e/pin-project-lite |
| Cargo | plist | 1.10.1 | MIT | windows / macos | https://github.com/ebarnard/rust-plist/ |
| Cargo | png | 0.17.16 | MIT OR Apache-2.0 | windows / macos | https://github.com/image-rs/image-png |
| Cargo | png | 0.18.1 | MIT OR Apache-2.0 | windows / macos | https://github.com/image-rs/image-png |
| Cargo | potential_utf | 0.1.6 | Unicode-3.0 | windows / macos | https://github.com/unicode-org/icu4x |
| Cargo | powerfmt | 0.2.0 | MIT OR Apache-2.0 | windows / macos | https://github.com/jhpratt/powerfmt |
| Cargo | precomputed-hash | 0.1.1 | MIT | windows / macos | https://github.com/emilio/precomputed-hash |
| Cargo | proc-macro2 | 1.0.107 | MIT OR Apache-2.0 | windows / macos | https://github.com/dtolnay/proc-macro2 |
| Cargo | pxfm | 0.1.30 | BSD-3-Clause OR Apache-2.0 | windows / macos | https://github.com/awxkee/pxfm |
| Cargo | quick-error | 2.0.1 | MIT/Apache-2.0 | windows / macos | http://github.com/tailhook/quick-error |
| Cargo | quick-xml | 0.42.0 | MIT | windows / macos | https://github.com/tafia/quick-xml |
| Cargo | quote | 1.0.47 | MIT OR Apache-2.0 | windows / macos | https://github.com/dtolnay/quote |
| Cargo | raw-window-handle | 0.6.2 | MIT OR Apache-2.0 OR Zlib | windows / macos | https://github.com/rust-windowing/raw-window-handle |
| Cargo | ref-cast | 1.0.27 | MIT OR Apache-2.0 | windows / macos | https://github.com/dtolnay/ref-cast |
| Cargo | ref-cast-impl | 1.0.27 | MIT OR Apache-2.0 | windows / macos | https://github.com/dtolnay/ref-cast |
| Cargo | regex | 1.13.1 | MIT OR Apache-2.0 | windows / macos | https://github.com/rust-lang/regex |
| Cargo | regex-automata | 0.4.18 | MIT OR Apache-2.0 | windows / macos | https://github.com/rust-lang/regex |
| Cargo | regex-syntax | 0.8.11 | MIT OR Apache-2.0 | windows / macos | https://github.com/rust-lang/regex |
| Cargo | rfd | 0.16.0 | MIT | windows / macos | https://github.com/PolyMeilex/rfd |
| Cargo | rustc-hash | 2.1.3 | Apache-2.0 OR MIT | windows / macos | https://github.com/rust-lang/rustc-hash |
| Cargo | same-file | 1.0.6 | Unlicense/MIT | windows / macos | https://github.com/BurntSushi/same-file |
| Cargo | schemars | 0.8.22 | MIT | windows / macos | https://github.com/GREsau/schemars |
| Cargo | schemars | 0.9.0 | MIT | windows / macos | https://github.com/GREsau/schemars |
| Cargo | schemars | 1.2.2 | MIT | windows / macos | https://github.com/GREsau/schemars |
| Cargo | schemars_derive | 0.8.22 | MIT | windows / macos | https://github.com/GREsau/schemars |
| Cargo | scopeguard | 1.2.0 | MIT OR Apache-2.0 | windows / macos | https://github.com/bluss/scopeguard |
| Cargo | selectors | 0.36.1 | MPL-2.0 | windows / macos | https://github.com/servo/stylo |
| Cargo | semver | 1.0.28 | MIT OR Apache-2.0 | windows / macos | https://github.com/dtolnay/semver |
| Cargo | serde | 1.0.229 | MIT OR Apache-2.0 | windows / macos | https://github.com/serde-rs/serde |
| Cargo | serde_core | 1.0.229 | MIT OR Apache-2.0 | windows / macos | https://github.com/serde-rs/serde |
| Cargo | serde_derive | 1.0.229 | MIT OR Apache-2.0 | windows / macos | https://github.com/serde-rs/serde |
| Cargo | serde_derive_internals | 0.29.1 | MIT OR Apache-2.0 | windows / macos | https://github.com/serde-rs/serde |
| Cargo | serde_json | 1.0.151 | MIT OR Apache-2.0 | windows / macos | https://github.com/serde-rs/json |
| Cargo | serde_repr | 0.1.21 | MIT OR Apache-2.0 | windows / macos | https://github.com/dtolnay/serde-repr |
| Cargo | serde_spanned | 1.1.1 | MIT OR Apache-2.0 | windows / macos | https://github.com/toml-rs/toml |
| Cargo | serde_with | 3.23.0 | MIT OR Apache-2.0 | windows / macos | https://github.com/jonasbb/serde_with/ |
| Cargo | serde_with_macros | 3.23.0 | MIT OR Apache-2.0 | windows / macos | https://github.com/jonasbb/serde_with/ |
| Cargo | serde-untagged | 0.1.9 | MIT OR Apache-2.0 | windows / macos | https://github.com/dtolnay/serde-untagged |
| Cargo | serialize-to-javascript | 0.1.2 | MIT OR Apache-2.0 | windows / macos | https://github.com/chippers/serialize-to-javascript |
| Cargo | serialize-to-javascript-impl | 0.1.2 | MIT OR Apache-2.0 | windows / macos | https://github.com/chippers/serialize-to-javascript |
| Cargo | servo_arc | 0.4.3 | MIT OR Apache-2.0 | windows / macos | https://github.com/servo/stylo |
| Cargo | sha2 | 0.10.9 | MIT OR Apache-2.0 | windows / macos | https://github.com/RustCrypto/hashes |
| Cargo | simd-adler32 | 0.3.10 | MIT | windows / macos | https://github.com/mcountryman/simd-adler32 |
| Cargo | siphasher | 1.0.3 | MIT/Apache-2.0 | windows / macos | https://github.com/jedisct1/rust-siphash |
| Cargo | smallvec | 1.16.1 | MIT OR Apache-2.0 | windows / macos | https://github.com/servo/rust-smallvec |
| Cargo | socket2 | 0.6.5 | MIT OR Apache-2.0 | windows / macos | https://github.com/rust-lang/socket2 |
| Cargo | softbuffer | 0.4.8 | MIT OR Apache-2.0 | windows | https://github.com/rust-windowing/softbuffer |
| Cargo | stable_deref_trait | 1.2.1 | MIT OR Apache-2.0 | windows / macos | https://github.com/storyyeller/stable_deref_trait |
| Cargo | string_cache | 0.9.0 | MIT OR Apache-2.0 | windows / macos | https://github.com/servo/string-cache |
| Cargo | strsim | 0.11.1 | MIT | windows / macos | https://github.com/rapidfuzz/strsim-rs |
| Cargo | swift-rs | 1.0.8 | MIT OR Apache-2.0 | macos | https://github.com/Brendonovich/swift-rs |
| Cargo | syn | 2.0.119 | MIT OR Apache-2.0 | windows / macos | https://github.com/dtolnay/syn |
| Cargo | syn | 3.0.6 | MIT OR Apache-2.0 | windows / macos | https://github.com/dtolnay/syn |
| Cargo | synstructure | 0.14.0 | MIT | windows / macos | https://github.com/mystor/synstructure |
| Cargo | tao | 0.35.3 | Apache-2.0 | windows / macos | https://github.com/tauri-apps/tao |
| Cargo | tauri | 2.11.6 | Apache-2.0 OR MIT | windows / macos | https://github.com/tauri-apps/tauri |
| Cargo | tauri-codegen | 2.6.3 | Apache-2.0 OR MIT | windows / macos | https://github.com/tauri-apps/tauri |
| Cargo | tauri-macros | 2.6.3 | Apache-2.0 OR MIT | windows / macos | https://github.com/tauri-apps/tauri |
| Cargo | tauri-plugin-dialog | 2.7.3 | Apache-2.0 OR MIT | windows / macos | https://github.com/tauri-apps/plugins-workspace |
| Cargo | tauri-plugin-fs | 2.5.2 | Apache-2.0 OR MIT | windows / macos | https://github.com/tauri-apps/plugins-workspace |
| Cargo | tauri-runtime | 2.11.3 | Apache-2.0 OR MIT | windows / macos | https://github.com/tauri-apps/tauri |
| Cargo | tauri-runtime-wry | 2.11.4 | Apache-2.0 OR MIT | windows / macos | https://github.com/tauri-apps/tauri |
| Cargo | tauri-utils | 2.9.3 | Apache-2.0 OR MIT | windows / macos | https://github.com/tauri-apps/tauri |
| Cargo | tendril | 0.5.1 | MIT OR Apache-2.0 | windows / macos | https://github.com/servo/html5ever |
| Cargo | thiserror | 1.0.69 | MIT OR Apache-2.0 | windows / macos | https://github.com/dtolnay/thiserror |
| Cargo | thiserror | 2.0.20 | MIT OR Apache-2.0 | windows / macos | https://github.com/dtolnay/thiserror |
| Cargo | thiserror-impl | 1.0.69 | MIT OR Apache-2.0 | windows / macos | https://github.com/dtolnay/thiserror |
| Cargo | thiserror-impl | 2.0.20 | MIT OR Apache-2.0 | windows / macos | https://github.com/dtolnay/thiserror |
| Cargo | time | 0.3.55 | MIT OR Apache-2.0 | windows / macos | https://github.com/time-rs/time |
| Cargo | time-core | 0.1.9 | MIT OR Apache-2.0 | windows / macos | https://github.com/time-rs/time |
| Cargo | time-macros | 0.2.32 | MIT OR Apache-2.0 | windows / macos | https://github.com/time-rs/time |
| Cargo | tinystr | 0.8.4 | Unicode-3.0 | windows / macos | https://github.com/unicode-org/icu4x |
| Cargo | tinyvec | 1.13.3 | Zlib OR Apache-2.0 OR MIT | windows / macos | https://github.com/Lokathor/tinyvec |
| Cargo | tokio | 1.53.1 | MIT | windows / macos | https://github.com/tokio-rs/tokio |
| Cargo | toml | 1.1.6+spec-1.1.0 | MIT OR Apache-2.0 | windows / macos | https://github.com/toml-rs/toml |
| Cargo | toml_datetime | 1.1.1+spec-1.1.0 | MIT OR Apache-2.0 | windows / macos | https://github.com/toml-rs/toml |
| Cargo | toml_parser | 1.1.3+spec-1.1.0 | MIT OR Apache-2.0 | windows / macos | https://github.com/toml-rs/toml |
| Cargo | toml_writer | 1.1.2+spec-1.1.0 | MIT OR Apache-2.0 | windows / macos | https://github.com/toml-rs/toml |
| Cargo | tracing | 0.1.44 | MIT | windows | https://github.com/tokio-rs/tracing |
| Cargo | tracing-core | 0.1.36 | MIT | windows | https://github.com/tokio-rs/tracing |
| Cargo | tray-icon | 0.24.2 | MIT OR Apache-2.0 | windows / macos | https://github.com/tauri-apps/tray-icon |
| Cargo | typeid | 1.0.3 | MIT OR Apache-2.0 | windows / macos | https://github.com/dtolnay/typeid |
| Cargo | typenum | 1.20.1 | MIT OR Apache-2.0 | windows / macos | https://github.com/paholg/typenum |
| Cargo | unic-char-property | 0.9.0 | MIT/Apache-2.0 | windows / macos | https://github.com/open-i18n/rust-unic/ |
| Cargo | unic-char-range | 0.9.0 | MIT/Apache-2.0 | windows / macos | https://github.com/open-i18n/rust-unic/ |
| Cargo | unic-common | 0.9.0 | MIT/Apache-2.0 | windows / macos | https://github.com/open-i18n/rust-unic/ |
| Cargo | unic-ucd-ident | 0.9.0 | MIT/Apache-2.0 | windows / macos | https://github.com/open-i18n/rust-unic/ |
| Cargo | unic-ucd-version | 0.9.0 | MIT/Apache-2.0 | windows / macos | https://github.com/open-i18n/rust-unic/ |
| Cargo | unicode-ident | 1.0.26 | (MIT OR Apache-2.0) AND Unicode-3.0 | windows / macos | https://github.com/dtolnay/unicode-ident |
| Cargo | unicode-segmentation | 1.13.3 | MIT OR Apache-2.0 | windows / macos | https://github.com/unicode-rs/unicode-segmentation |
| Cargo | url | 2.5.8 | MIT OR Apache-2.0 | windows / macos | https://github.com/servo/rust-url |
| Cargo | urlpattern | 0.3.0 | MIT | windows / macos | https://github.com/denoland/rust-urlpattern |
| Cargo | utf8_iter | 1.0.4 | Apache-2.0 OR MIT | windows / macos | https://github.com/hsivonen/utf8_iter |
| Cargo | uuid | 1.26.1 | Apache-2.0 OR MIT | windows / macos | https://github.com/uuid-rs/uuid |
| Cargo | walkdir | 2.5.0 | Unlicense/MIT | windows / macos | https://github.com/BurntSushi/walkdir |
| Cargo | web_atoms | 0.2.6 | MIT OR Apache-2.0 | windows / macos | https://github.com/servo/html5ever |
| Cargo | webview2-com | 0.38.2 | MIT | windows | https://github.com/wravery/webview2-rs |
| Cargo | webview2-com-macros | 0.8.1 | MIT | windows | https://github.com/wravery/webview2-rs |
| Cargo | webview2-com-sys | 0.38.2 | MIT | windows | https://github.com/wravery/webview2-rs |
| Cargo | winapi-util | 0.1.11 | Unlicense OR MIT | windows | https://github.com/BurntSushi/winapi-util |
| Cargo | window-vibrancy | 0.6.0 | Apache-2.0 OR MIT | windows / macos | https://github.com/tauri-apps/tauri-plugin-vibrancy |
| Cargo | windows | 0.61.3 | MIT OR Apache-2.0 | windows | https://github.com/microsoft/windows-rs |
| Cargo | windows_x86_64_gnu | 0.52.6 | MIT OR Apache-2.0 | windows | https://github.com/microsoft/windows-rs |
| Cargo | windows_x86_64_gnu | 0.53.1 | MIT OR Apache-2.0 | windows | https://github.com/microsoft/windows-rs |
| Cargo | windows-collections | 0.2.0 | MIT OR Apache-2.0 | windows | https://github.com/microsoft/windows-rs |
| Cargo | windows-core | 0.61.2 | MIT OR Apache-2.0 | windows | https://github.com/microsoft/windows-rs |
| Cargo | windows-future | 0.2.1 | MIT OR Apache-2.0 | windows | https://github.com/microsoft/windows-rs |
| Cargo | windows-implement | 0.60.2 | MIT OR Apache-2.0 | windows | https://github.com/microsoft/windows-rs |
| Cargo | windows-interface | 0.59.3 | MIT OR Apache-2.0 | windows | https://github.com/microsoft/windows-rs |
| Cargo | windows-link | 0.1.3 | MIT OR Apache-2.0 | windows | https://github.com/microsoft/windows-rs |
| Cargo | windows-link | 0.2.1 | MIT OR Apache-2.0 | windows | https://github.com/microsoft/windows-rs |
| Cargo | windows-numerics | 0.2.0 | MIT OR Apache-2.0 | windows | https://github.com/microsoft/windows-rs |
| Cargo | windows-result | 0.3.4 | MIT OR Apache-2.0 | windows | https://github.com/microsoft/windows-rs |
| Cargo | windows-strings | 0.4.2 | MIT OR Apache-2.0 | windows | https://github.com/microsoft/windows-rs |
| Cargo | windows-sys | 0.59.0 | MIT OR Apache-2.0 | windows | https://github.com/microsoft/windows-rs |
| Cargo | windows-sys | 0.60.2 | MIT OR Apache-2.0 | windows | https://github.com/microsoft/windows-rs |
| Cargo | windows-sys | 0.61.2 | MIT OR Apache-2.0 | windows | https://github.com/microsoft/windows-rs |
| Cargo | windows-targets | 0.52.6 | MIT OR Apache-2.0 | windows | https://github.com/microsoft/windows-rs |
| Cargo | windows-targets | 0.53.5 | MIT OR Apache-2.0 | windows | https://github.com/microsoft/windows-rs |
| Cargo | windows-threading | 0.1.0 | MIT OR Apache-2.0 | windows | https://github.com/microsoft/windows-rs |
| Cargo | windows-version | 0.1.7 | MIT OR Apache-2.0 | windows | https://github.com/microsoft/windows-rs |
| Cargo | winnow | 1.0.4 | MIT | windows / macos | https://github.com/winnow-rs/winnow |
| Cargo | writeable | 0.6.4 | Unicode-3.0 | windows / macos | https://github.com/unicode-org/icu4x |
| Cargo | wry | 0.55.1 | Apache-2.0 OR MIT | windows / macos | https://github.com/tauri-apps/wry |
| Cargo | yoke | 0.8.3 | Unicode-3.0 | windows / macos | https://github.com/unicode-org/icu4x |
| Cargo | yoke-derive | 0.8.3 | Unicode-3.0 | windows / macos | https://github.com/unicode-org/icu4x |
| Cargo | zerofrom | 0.1.8 | Unicode-3.0 | windows / macos | https://github.com/unicode-org/icu4x |
| Cargo | zerofrom-derive | 0.1.8 | Unicode-3.0 | windows / macos | https://github.com/unicode-org/icu4x |
| Cargo | zerotrie | 0.2.5 | Unicode-3.0 | windows / macos | https://github.com/unicode-org/icu4x |
| Cargo | zerovec | 0.11.8 | Unicode-3.0 | windows / macos | https://github.com/unicode-org/icu4x |
| Cargo | zerovec-derive | 0.11.6 | Unicode-3.0 | windows / macos | https://github.com/unicode-org/icu4x |
| Cargo | zlib-rs | 0.6.8 | Zlib | windows / macos | https://github.com/trifectatechfoundation/zlib-rs |
| Cargo | zmij | 1.0.23 | MIT | windows / macos | https://github.com/dtolnay/zmij |
| Cargo | zune-core | 0.5.3 | MIT OR Apache-2.0 OR Zlib | windows / macos | https://github.com/etemesi254/zune-image |
| Cargo | zune-jpeg | 0.5.15 | MIT OR Apache-2.0 OR Zlib | windows / macos | https://github.com/etemesi254/zune-image/tree/dev/crates/zune-jpeg |
| npm | @codemirror/autocomplete | 6.20.3 | MIT | windows / macos | https://code.haverbeke.berlin/codemirror/autocomplete.git |
| npm | @codemirror/commands | 6.8.1 | MIT | windows / macos | https://github.com/codemirror/commands.git |
| npm | @codemirror/lang-javascript | 6.2.5 | MIT | windows / macos | https://github.com/codemirror/lang-javascript.git |
| npm | @codemirror/language | 6.12.4 | MIT | windows / macos | https://code.haverbeke.berlin/codemirror/language.git |
| npm | @codemirror/lint | 6.9.7 | MIT | windows / macos | https://code.haverbeke.berlin/codemirror/lint.git |
| npm | @codemirror/merge | 6.12.2 | MIT | windows / macos | https://code.haverbeke.berlin/codemirror/merge.git |
| npm | @codemirror/search | 6.7.2 | MIT | windows / macos | https://code.haverbeke.berlin/codemirror/search.git |
| npm | @codemirror/state | 6.5.2 | MIT | windows / macos | https://github.com/codemirror/state.git |
| npm | @codemirror/state | 6.7.5 | MIT | windows / macos | https://code.haverbeke.berlin/codemirror/state.git |
| npm | @codemirror/theme-one-dark | 6.1.3 | MIT | windows / macos | https://github.com/codemirror/theme-one-dark.git |
| npm | @codemirror/view | 6.38.6 | MIT | windows / macos | https://github.com/codemirror/view.git |
| npm | @codemirror/view | 6.43.12 | MIT | windows / macos | https://code.haverbeke.berlin/codemirror/view.git |
| npm | @lezer/common | 1.5.2 | MIT | windows / macos | https://github.com/lezer-parser/common.git |
| npm | @lezer/highlight | 1.2.3 | MIT | windows / macos | https://github.com/lezer-parser/highlight.git |
| npm | @lezer/javascript | 1.5.5 | MIT | windows / macos | https://code.haverbeke.berlin/lezer/javascript.git |
| npm | @lezer/lr | 1.4.10 | MIT | windows / macos | https://code.haverbeke.berlin/lezer/lr.git |
| npm | @marijn/find-cluster-break | 1.0.4 | MIT | windows / macos | https://code.haverbeke.berlin/marijn/find-cluster-break.git |
| npm | @tauri-apps/api | 2.11.1 | Apache-2.0 OR MIT | windows / macos | https://github.com/tauri-apps/tauri.git |
| npm | @tauri-apps/plugin-dialog | 2.7.3 | MIT OR Apache-2.0 | windows / macos | https://github.com/tauri-apps/plugins-workspace |
| npm | crelt | 1.0.7 | MIT | windows / macos | https://code.haverbeke.berlin/marijn/crelt.git |
| npm | react | 19.1.1 | MIT | windows / macos | https://github.com/facebook/react.git |
| npm | react-dom | 19.1.1 | MIT | windows / macos | https://github.com/facebook/react.git |
| npm | scheduler | 0.26.0 | MIT | windows / macos | https://github.com/facebook/react.git |
| npm | style-mod | 4.1.4 | MIT | windows / macos | https://code.haverbeke.berlin/marijn/style-mod.git |
| npm | w3c-keyname | 2.2.8 | MIT | windows / macos | https://github.com/marijnh/w3c-keyname.git |
