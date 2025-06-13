# OpenAI + Cartesia Test

A quick AI STT > LLM> TTS pipeline test

### Install

```shell
cp server/.env.example server/.env
npm install
npm start
```

### Server Test

```shell
npm --prefix server test
```

Expected output:

```text
TTS 431
LLM 948
TTS 3183
Execution time 4565
```
