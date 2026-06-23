# 黑读

本地个人阅读网站，面向 `D:\18\Desktop\书籍` 目录。

功能：
- 目录页展示本地书籍，点击进入阅读器
- EPUB 通过 `epub.js` 进行类似 Kindle 的分页阅读
- TXT / PDF 走文本模式，PDF 会先抽取文本再用沉浸式排版阅读
- 每本书单独保存阅读进度
- 每本书单独保存本地笔记
- 极简黑色界面，仿宋加粗，支持字号调节

## 启动

```bash
npm install
npm run scan
npm start
```

打开：

- `http://localhost:4318`

## 目录来源

默认书籍目录：

- `D:\18\Desktop\书籍`

如果你以后想换目录，可以临时指定：

```bash
set BOOKS_DIR=D:\你的目录
npm run scan
npm start
```

## 说明

- 新增书后，重新运行一次 `npm run scan`
- 笔记和阅读进度保存在浏览器 `localStorage`
- PDF 当前方案是“抽取文本后重排”，更接近 Kindle 式阅读，而不是直接嵌一个 PDF 预览器
