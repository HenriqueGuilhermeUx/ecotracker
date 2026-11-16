# EcoTracker — iOS preflight

- Current mobile source: `mobile/` (Expo SDK 56).
- Existing iOS bundle identifier: `com.alternativeventures.ecotracker`.
- Android remains unchanged.
- This first workflow validates the Expo iOS JavaScript bundle; it **does not** generate an IPA or submit to Apple.
- Next: verify run, compile native app, test launch, privacy notice, account deletion, screens and signing.
## Evidências verificadas e gate de identidade iOS — 16/11/2026

- A versão anterior deste documento dizia que o workflow apenas exportava JavaScript. Isto está desatualizado: o [preflight nativo #43052534652](https://github.com/HenriqueGuilhermeUx/ecotracker/actions/runs/43052534652) terminou **SUCCESS**, incluindo Expo prebuild, CocoaPods, compilação iOS unsigned, instalação/abertura no simulador e captura de tela. A evidência vale para o commit testado.
- No commit `e0bf7a1`, o workflow `.github/workflows/ios-native-preflight.yml` foi reforçado para exigir `CFBundleIdentifier=com.alternativeventures.ecotracker` e presença de família de dispositivo iPad `UIDeviceFamily=2` no binário gerado. Não equivale a QA funcional em iPad. Validar conclusão do novo CI antes de marcar esta alteração como PASS.
- `mobile/app.json` contém uma **possível divergência de identidade jurídica**: o campo `extra.company` declara `Alternative Ventures Ltda`, enquanto informações corporativas fornecidas pelo titular anteriormente apontam para denominação diferente. Não alterar automaticamente razão social/CNPJ no produto nem nos metadados Apple sem conferência dos documentos oficiais.
- `mobile/app.json` declara `usesNonExemptEncryption: false`. Esse valor não é uma avaliação jurídica de conformidade de criptografia; revisar os SDKs/bibliotecas e o questionário Apple antes do lançamento.
- Fase 2 continua bloqueada por verificação Play Console/AAB, autenticação, telas e processos de compra e aposentadoria de créditos em ambiente simulado (sem transações reais), política de privacidade/exclusão, dispositivos físicos iPhone/iPad, Apple Developer e assinatura. Não usar credenciais Carbonmark, pagamentos, ou operações reais em QA iOS.
