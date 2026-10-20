/* Image editor: loaded on first explicit image action. */
(function (root) {
  "use strict";
  root.PiImageEditor = { create(deps) {
    const { HISTORY_IMAGE_FAST_PATH_MAX_BYTES, HISTORY_IMAGE_MAX_BYTES, appendComposerImageState, closeComposerImageZoomModal, isMobileEnvironment, parseHistoryImageDataUrl, readBlobAsDataUrl, readNativeComposerDraft, replaceComposerImageState, showToast } = deps;
    return function openComposerImageZoomModal(src, alt = "图片预览", editContext = null, galleryContext = null, options = null) {
    closeComposerImageZoomModal();
    if (!src) return;

    let items = Array.isArray(galleryContext?.items) && galleryContext.items.length > 0
      ? galleryContext.items.slice()
      : [{ src, alt, editContext }];
    let currentIndex = Number.isInteger(galleryContext?.initialIndex)
      && galleryContext.initialIndex >= 0
      && galleryContext.initialIndex < items.length
      ? galleryContext.initialIndex
      : 0;
    const addedHistoryImageSources = new Set();
    let isAddingHistoryImage = false;
    let addHistoryImageAbortController = null;
    let addHistoryImageOperation = 0;

    const previousActiveElement = (typeof document !== "undefined" && document.activeElement) ? document.activeElement : null;

    const dialog = document.createElement("dialog");
    dialog.className = "image-preview-dialog pi-enh-image-zoom-dialog";
    dialog.setAttribute("aria-label", "图片预览");
    dialog.tabIndex = -1;
    if (options?.dblClickPreview) dialog.__isDblClickPreview = true;
    if (options?.source === "queue") {
      dialog.setAttribute("data-pi-queue-gallery", "true");
    }

    // 顶部多图序号标记
    const counterEl = document.createElement("div");
    counterEl.className = "pi-enh-gallery-counter";
    counterEl.setAttribute("role", "status");
    counterEl.setAttribute("aria-live", "polite");

    // 左右两侧三角形切图按键
    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "pi-enh-gallery-nav-btn is-prev";
    prevBtn.setAttribute("data-gallery-nav", "prev");
    prevBtn.setAttribute("aria-label", "上一张截图 (←)");
    prevBtn.title = "上一张截图 (←)";
    prevBtn.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/>
      </svg>
    `;

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "pi-enh-gallery-nav-btn is-next";
    nextBtn.setAttribute("data-gallery-nav", "next");
    nextBtn.setAttribute("aria-label", "下一张截图 (→)");
    nextBtn.title = "下一张截图 (→)";
    nextBtn.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
      </svg>
    `;

    const img = document.createElement("img");
    img.className = "image-preview-image pi-enh-zoomable";
    img.classList?.add?.("pi-enh-zoomable");
    img.src = src;
    img.alt = alt;
    if (typeof img.setAttribute === "function") {
      img.setAttribute("src", src);
      img.setAttribute("alt", alt);
    }

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "image-preview-close";
    closeBtn.setAttribute("aria-label", "关闭");
    closeBtn.title = "关闭 (Esc)";
    closeBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M6 6l12 12M18 6 6 18" />
      </svg>
    `;

    // 缩放控制工具条
    const toolbar = document.createElement("div");
    toolbar.className = "pi-enh-zoom-toolbar";

    const zoomOutBtn = document.createElement("button");
    zoomOutBtn.type = "button";
    zoomOutBtn.className = "pi-enh-zoom-btn";
    zoomOutBtn.setAttribute("data-zoom-action", "out");
    zoomOutBtn.setAttribute("aria-label", "缩小 (-)");
    zoomOutBtn.title = "缩小 (-)";
    zoomOutBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"></line></svg>';

    const indicator = document.createElement("span");
    indicator.className = "pi-enh-zoom-indicator";
    indicator.setAttribute("data-zoom-action", "reset");
    indicator.setAttribute("aria-label", "重置缩放 (0)");
    indicator.title = "点击或按 0 重置缩放";
    indicator.textContent = "100%";

    const zoomInBtn = document.createElement("button");
    zoomInBtn.type = "button";
    zoomInBtn.className = "pi-enh-zoom-btn";
    zoomInBtn.setAttribute("data-zoom-action", "in");
    zoomInBtn.setAttribute("aria-label", "放大 (+)");
    zoomInBtn.title = "放大 (+)";
    zoomInBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>';

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "pi-enh-zoom-btn pi-enh-zoom-edit-btn";
    editBtn.setAttribute("data-zoom-action", "edit");
    editBtn.setAttribute("aria-label", "编辑与标注图片");
    editBtn.title = "编辑与标注图片";
    editBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="margin-right: 4px;"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>编辑';

    const downloadBtn = document.createElement("button");
    downloadBtn.type = "button";
    downloadBtn.className = "pi-enh-zoom-btn pi-enh-zoom-download-btn";
    downloadBtn.setAttribute("data-zoom-action", "download");
    downloadBtn.setAttribute("aria-label", "下载图片");
    downloadBtn.title = "下载图片";
    downloadBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="margin-right: 4px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>下载';

    let addToConversationLabel = null;
    const addToConversationBtn = options?.allowAddToConversation ? document.createElement("button") : null;
    if (addToConversationBtn) {
      addToConversationBtn.type = "button";
      addToConversationBtn.className = "pi-enh-zoom-btn pi-enh-zoom-add-to-chat-btn";
      addToConversationBtn.setAttribute("data-zoom-action", "add-to-chat");
      addToConversationBtn.setAttribute("aria-label", "添加到当前对话");
      addToConversationBtn.title = "添加到当前对话";
      // Center the history toolbar against the mobile viewport, not the padded dialog content box.
      toolbar.style.position = "fixed";
      addToConversationBtn.style.gap = "4px";
      addToConversationBtn.style.padding = "3px 6px";
      const addIcon = document.createElement("span");
      addIcon.setAttribute("aria-hidden", "true");
      addIcon.textContent = "+";
      addIcon.style.fontSize = "17px";
      addIcon.style.lineHeight = "1";
      addToConversationLabel = document.createElement("span");
      addToConversationLabel.textContent = "添加到对话";
      addToConversationBtn.appendChild(addIcon);
      addToConversationBtn.appendChild(addToConversationLabel);
      addToConversationBtn.addEventListener("click", (e) => {
        e.preventDefault?.();
        e.stopPropagation?.();
        void addHistoryImageToCurrentConversation();
      });
    }

    downloadBtn.addEventListener("click", (e) => {
      e.stopPropagation?.();
      try {
        const currentItem = items[currentIndex];
        const currentSrc = currentItem?.src || src;
        const currentAlt = currentItem?.alt || alt || "image";
        const a = document.createElement("a");
        a.href = currentSrc;
        a.download = (currentAlt || "image").replace(/[^\w.-]/g, "_") + ".png";
        a.target = "_blank";
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch (err) {}
    });

    toolbar.appendChild(editBtn);
    toolbar.appendChild(zoomOutBtn);
    toolbar.appendChild(indicator);
    toolbar.appendChild(zoomInBtn);
    toolbar.appendChild(downloadBtn);
    if (addToConversationBtn) toolbar.appendChild(addToConversationBtn);

    dialog.appendChild(counterEl);
    dialog.appendChild(prevBtn);
    dialog.appendChild(nextBtn);
    dialog.appendChild(img);
    dialog.appendChild(closeBtn);
    dialog.appendChild(toolbar);
    document.body.appendChild(dialog);
    deps.activeZoomDialog = dialog;

    const modalOpenedAt = performance.now();
    const prevOverflow = document.body.style?.overflow;
    if (document.body.style) {
      document.body.style.overflow = "hidden";
    }

    let scale = 1;
    let translateX = 0;
    let translateY = 0;
    let isDragging = false;
    let hasDragged = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let initialTranslateX = 0;
    let initialTranslateY = 0;
    let editorRoot = null;
    let disposeEditor = null;
    let editorController = null;
    let historyPushed = false;

    const isMobileDevice = Boolean(
      typeof window !== "undefined" && (
        (window.matchMedia && window.matchMedia("(max-width: 768px), (hover: none)").matches)
        || ("ontouchstart" in window)
      )
    );

    if (isMobileDevice && typeof window.history?.pushState === "function") {
      try {
        window.history.pushState({ __piEnhImageModal: true }, "");
        historyPushed = true;
      } catch (e) {}
    }

    const onPopState = () => {
      historyPushed = false;
      if (editorController && editorController.isPromptActive()) {
        cleanup();
        return;
      }
      if (editorController && editorController.hasEdits()) {
        try {
          if (typeof window.history?.pushState === "function") {
            window.history.pushState({ __piEnhImageModal: true }, "");
            historyPushed = true;
          }
        } catch (e) {}
        editorController.promptExit();
      } else {
        cleanup();
      }
    };
    window.addEventListener("popstate", onPopState);

    function updateGalleryUi() {
      if (addToConversationBtn) {
        const currentSource = items[currentIndex]?.src || src;
        const isAdded = addedHistoryImageSources.has(currentSource);
        addToConversationBtn.disabled = isAddingHistoryImage || isAdded;
        addToConversationLabel.textContent = isAddingHistoryImage ? "添加中…" : isAdded ? "已添加" : "添加到对话";
        addToConversationBtn.setAttribute("aria-label", isAdded ? "已添加到当前对话" : "添加到当前对话");
        addToConversationBtn.title = isAdded ? "已添加到当前对话" : "添加到当前对话";
      }
      const total = items.length;
      if (total <= 1) {
        counterEl.style.display = "none";
        prevBtn.style.display = "none";
        nextBtn.style.display = "none";
        return;
      }
      counterEl.style.display = "";
      counterEl.textContent = `第 ${currentIndex + 1} 张截图 · ${currentIndex + 1}/${total}`;
      prevBtn.style.display = "";
      prevBtn.disabled = currentIndex <= 0;
      nextBtn.style.display = "";
      nextBtn.disabled = currentIndex >= total - 1;
    }

    async function addHistoryImageToCurrentConversation() {
      if (!addToConversationBtn || isAddingHistoryImage) return;
      const currentItem = items[currentIndex] || { src, alt };
      const currentSource = currentItem.src || src;
      if (!currentSource) {
        showToast("找不到这张图片", null, 2600);
        return;
      }

      const nativeBefore = readNativeComposerDraft();
      if (!nativeBefore || typeof nativeBefore.handle?.addImages !== "function") {
        showToast("找不到当前对话的输入框", null, 3000);
        return;
      }
      const beforeCount = nativeBefore.imagesRef.current.length;
      const beforePending = nativeBefore.pendingRef.current;
      if (beforeCount + beforePending >= 10) {
        showToast("当前对话最多添加 10 张图片", null, 3000);
        return;
      }

      const directSourceImage = parseHistoryImageDataUrl(currentSource);
      if (directSourceImage && directSourceImage.byteLength > HISTORY_IMAGE_MAX_BYTES) {
        showToast("图片超过 10 MB，无法添加", null, 3000);
        return;
      }
      const sourceCanSkipNativeCompression = directSourceImage
        && (directSourceImage.byteLength <= HISTORY_IMAGE_FAST_PATH_MAX_BYTES
          || directSourceImage.mimeType === "image/gif" || typeof createImageBitmap !== "function");
      // ChatInput only compresses images above 1 MiB (except GIF); reusing those
      // already-Base64 sources avoids a redundant fetch/FileReader pass without
      // changing the native compression policy for larger images.
      if (sourceCanSkipNativeCompression
        && appendComposerImageState(nativeBefore, {
          ...directSourceImage,
          previewUrl: currentSource,
        })) {
        addedHistoryImageSources.add(currentSource);
        showToast("已添加到当前对话", null, 2400);
        closeComposerImageZoomModal();
        return;
      }

      isAddingHistoryImage = true;
      const operation = ++addHistoryImageOperation;
      addHistoryImageAbortController = typeof AbortController === "function" ? new AbortController() : null;
      const abortController = addHistoryImageAbortController;
      updateGalleryUi();

      try {
        const protocol = new URL(currentSource, window.location.href).protocol;
        if (!(["http:", "https:", "blob:", "data:"].includes(protocol))
          || (protocol === "data:" && !/^data:image\//i.test(currentSource))) {
          throw new Error("图片来源不受支持");
        }
        const response = await fetch(currentSource, {
          credentials: "same-origin",
          signal: abortController?.signal,
        });
        if (!response.ok) throw new Error("图片读取失败");
        const blob = await response.blob();
        if (!blob.size) throw new Error("图片内容为空");
        if (blob.size > HISTORY_IMAGE_MAX_BYTES) throw new Error("图片超过 10 MB，无法添加");

        const hintedName = String(currentItem.alt || "历史图片").split(/[\\/]/).pop() || "历史图片";
        const extensionHint = hintedName.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase();
        const mimeByExtension = {
          avif: "image/avif", bmp: "image/bmp", gif: "image/gif", jpeg: "image/jpeg",
          jpg: "image/jpeg", png: "image/png", svg: "image/svg+xml", webp: "image/webp",
        };
        const dataMime = currentSource.match(/^data:(image\/[^;,]+)/i)?.[1]?.toLowerCase();
        const mimeType = String(blob.type || "").toLowerCase().startsWith("image/")
          ? blob.type.split(";")[0].toLowerCase()
          : dataMime || mimeByExtension[extensionHint];
        if (!mimeType || !mimeType.startsWith("image/")) throw new Error("无法识别图片格式");

        const liveNative = readNativeComposerDraft();
        if (!liveNative || liveNative.key !== nativeBefore.key || typeof liveNative.handle?.addImages !== "function") {
          throw new Error("当前对话已切换，请重新添加");
        }
        if (liveNative.imagesRef.current.length + liveNative.pendingRef.current >= 10) {
          throw new Error("当前对话最多添加 10 张图片");
        }

        const canSkipNativeCompression = blob.size <= HISTORY_IMAGE_FAST_PATH_MAX_BYTES || mimeType === "image/gif"
          || typeof createImageBitmap !== "function";
        if (canSkipNativeCompression && liveNative.pendingRef.current === 0 && liveNative.imageStateHook) {
          const typedBlob = blob.type === mimeType ? blob : new Blob([blob], { type: mimeType });
          let dataUrl = null;
          try { dataUrl = await readBlobAsDataUrl(typedBlob); } catch (error) {}
          if (operation !== addHistoryImageOperation || !dialog.isConnected) return;
          const directImage = dataUrl && parseHistoryImageDataUrl(dataUrl);
          if (directImage && directImage.byteLength === blob.size) {
            let previewUrl = dataUrl;
            let objectUrl = false;
            try {
              previewUrl = URL.createObjectURL(typedBlob);
              objectUrl = true;
            } catch (error) {}
            if (appendComposerImageState(liveNative, { ...directImage, previewUrl })) {
              addedHistoryImageSources.add(currentSource);
              showToast("已添加到当前对话", null, 2400);
              closeComposerImageZoomModal();
              return;
            }
            if (objectUrl) {
              try { URL.revokeObjectURL(previewUrl); } catch (error) {}
            }
          }
        }

        const extensionByMime = {
          "image/avif": "avif", "image/bmp": "bmp", "image/gif": "gif", "image/jpeg": "jpg",
          "image/png": "png", "image/svg+xml": "svg", "image/webp": "webp",
        };
        const extension = extensionByMime[mimeType] || extensionHint || "png";
        const fileBase = hintedName
          .replace(/\.[^.]+$/, "")
          .replace(/[<>:\"|?*]/g, "_")
          .replace(/\s+/g, "_")
          .slice(0, 80) || "历史图片";
        const imageFile = new File([blob], `${fileBase}.${extension}`, { type: mimeType });
        const pendingBefore = liveNative.pendingRef.current;
        liveNative.handle.addImages([imageFile]);
        if (liveNative.pendingRef.current <= pendingBefore) {
          throw new Error("图片未能添加，请检查图片大小或数量");
        }
        addedHistoryImageSources.add(currentSource);
        showToast("已添加到当前对话", null, 2400);
        closeComposerImageZoomModal();
      } catch (error) {
        if (operation === addHistoryImageOperation && dialog.isConnected) {
          showToast(`添加失败：${error?.message || "图片无法读取"}`, null, 3600);
        }
      } finally {
        if (operation === addHistoryImageOperation) {
          addHistoryImageAbortController = null;
          isAddingHistoryImage = false;
          updateGalleryUi();
        }
      }
    }

    function switchTo(index) {
      if (index < 0 || index >= items.length) return;
      if (editorController && editorController.hasEdits()) {
        editorController.promptExit();
        return;
      }
      const wasEditing = Boolean(editorRoot);
      if (wasEditing) {
        leaveImageEditor();
      }
      const keepQueueFocus = options?.source === "queue"
        && (document.activeElement === prevBtn || document.activeElement === nextBtn);
      currentIndex = index;
      const currentItem = items[currentIndex];
      editContext = currentItem.editContext || null;
      src = currentItem.src;
      alt = currentItem.alt || `第 ${currentIndex + 1} 张截图`;
      img.src = src;
      if (typeof img.setAttribute === "function") {
        img.setAttribute("src", src);
        img.setAttribute("alt", alt);
      }
      resetZoom();
      updateGalleryUi();
      // Boundary navigation disables the clicked button; retain arrow-key focus in this gallery.
      if (keepQueueFocus) dialog.focus({ preventScroll: true });
      if (wasEditing) {
        enterImageEditor();
      }
    }

    prevBtn.addEventListener("click", (e) => {
      e.stopPropagation?.();
      switchTo(currentIndex - 1);
    });

    nextBtn.addEventListener("click", (e) => {
      e.stopPropagation?.();
      switchTo(currentIndex + 1);
    });

    function leaveImageEditor() {
      if (typeof disposeEditor === "function") {
        try { disposeEditor(); } catch (error) {}
      }
      disposeEditor = null;
      editorController = null;
      if (editorRoot) {
        try { editorRoot.remove(); } catch (error) {}
        editorRoot = null;
      }
      dialog.classList?.remove?.("is-editing");
      img.style.display = "";
      toolbar.style.display = "";
      updateGalleryUi();
    }

    function enterImageEditor() {
      if (editorRoot) return;
      resetZoom();
      dialog.classList?.add?.("is-editing");
      img.style.display = "none";
      toolbar.style.display = "none";
      updateGalleryUi();

      const editor = document.createElement("div");
      editor.className = "pi-enh-image-editor";
      editor.setAttribute("role", "region");
      editor.setAttribute("aria-label", "图片标注编辑器");

      const stage = document.createElement("div");
      stage.className = "pi-enh-image-editor-stage";
      const canvas = document.createElement("canvas");
      canvas.className = "pi-enh-annotation-canvas";
      canvas.setAttribute("aria-label", "图片标注画布");
      stage.appendChild(canvas);

      const TIPS_STORAGE_KEY = "pi-enh-image-editor-tips-dismissed";
      const TOOL_STORAGE_KEY = "pi-enh-image-editor-tool";
      const LINE_WIDTH_STORAGE_KEY = "pi-enh-image-editor-line-width";
      const VALID_TOOLS = ["pen", "rect", "crop"];
      const TOOL_NAMES = {
        rect: "矩形",
        pen: "画笔",
        crop: "裁剪",
      };

      const isTipsDismissed = () => {
        try {
          return localStorage.getItem(TIPS_STORAGE_KEY) === "true";
        } catch (e) {
          return false;
        }
      };

      const parseValidLineWidth = (raw) => {
        if (typeof raw !== "string") return null;
        const trimmed = raw.trim();
        if (!/^\d+$/.test(trimmed)) return null;
        const num = Number(trimmed);
        if (Number.isInteger(num) && num >= 1 && num <= 48) {
          return num;
        }
        return null;
      };

      const getValidSavedTool = () => {
        try {
          const saved = localStorage.getItem(TOOL_STORAGE_KEY);
          if (saved && VALID_TOOLS.includes(saved)) {
            return saved;
          }
        } catch (e) {}
        return null;
      };

      const getValidSavedWidth = () => {
        try {
          return parseValidLineWidth(localStorage.getItem(LINE_WIDTH_STORAGE_KEY));
        } catch (e) {}
        return null;
      };

      const readSavedTool = () => getValidSavedTool() || "rect";

      const saveTool = (nextTool) => {
        if (!VALID_TOOLS.includes(nextTool)) return;
        try {
          localStorage.setItem(TOOL_STORAGE_KEY, nextTool);
        } catch (e) {}
      };

      const readSavedLineWidth = () => getValidSavedWidth() ?? 8;

      const saveLineWidth = (nextWidth) => {
        const rounded = Math.round(nextWidth);
        if (!Number.isInteger(rounded) || rounded < 1 || rounded > 48) return;
        try {
          localStorage.setItem(LINE_WIDTH_STORAGE_KEY, String(rounded));
        } catch (e) {}
      };

      const hasSavedPreference = () => {
        return Boolean(getValidSavedTool() !== null || getValidSavedWidth() !== null);
      };

      const getToolHintStatus = (targetTool) => {
        if (targetTool === "crop") {
          return "在图片上单指拖拽框选裁剪区域，点击“确认裁剪”生效";
        }
        if (targetTool === "pen") {
          return "拖拽画线；滚轮或双指上下滑会立即改变当前画笔的可见粗细";
        }
        return "拖拽画矩形；滚轮或双指上下滑会立即改变当前红框的可见粗细";
      };

      let tool = readSavedTool();
      let color = "#ef4444";
      let lineWidth = readSavedLineWidth();

      const topHud = document.createElement("div");
      topHud.className = "pi-enh-image-editor-top-hud";
      topHud.setAttribute("aria-hidden", "false");

      const thicknessHud = document.createElement("div");
      thicknessHud.className = "pi-enh-image-thickness-hud";
      thicknessHud.setAttribute("aria-hidden", "true");
      thicknessHud.innerHTML = `<span class="pi-enh-hud-dot"></span><span class="pi-enh-hud-text">${lineWidth}px</span>`;

      const isTouchDevice = Boolean(
        typeof window !== "undefined" && (
          ("ontouchstart" in window)
          || (window.navigator?.maxTouchPoints > 0 && window.innerWidth <= 800)
          || (window.matchMedia && window.matchMedia("(max-width: 600px)").matches)
        )
      );

      const isMac = Boolean(
        typeof navigator !== "undefined" && (
          (navigator.userAgentData?.platform === "macOS")
          || /(Mac|iPhone|iPod|iPad)/i.test(navigator.platform || navigator.userAgent || "")
        )
      );
      const undoShortcut = isMac ? "Cmd+Z" : "Ctrl+Z";

      const renderTipsBodyHtml = () => {
        const currentToolLabel = TOOL_NAMES[tool] || "矩形";
        const savedTool = getValidSavedTool();
        const hasPref = hasSavedPreference();

        let memoryDesc = "默认矩形框选 (8px)";
        let touchDesc = "已记忆：矩形 (8px)";

        if (hasPref) {
          if (savedTool && savedTool !== tool) {
            // 如裁剪后内部切矩形，指引不应误称裁剪是当前工具，可标为上次选用
            const savedToolLabel = TOOL_NAMES[savedTool] || savedTool;
            memoryDesc = `当前：${currentToolLabel} (${lineWidth}px) · 上次选用：${savedToolLabel}`;
            touchDesc = `当前：${currentToolLabel} (${lineWidth}px) · 上次：${savedToolLabel}`;
          } else {
            memoryDesc = `已记住上次：${currentToolLabel} (${lineWidth}px)`;
            touchDesc = `已记忆：${currentToolLabel} (${lineWidth}px)`;
          }
        }

        if (isTouchDevice) {
          return `
            <div class="pi-enh-tips-content">
              <div class="pi-enh-tips-row pi-enh-tips-row-actions">
                <span class="pi-enh-tips-action-item"><span class="pi-enh-tips-badge">双指滑</span>调粗细</span>
                <span class="pi-enh-tips-divider">·</span>
                <span class="pi-enh-tips-action-item"><span class="pi-enh-tips-badge">${undoShortcut}</span>撤销</span>
              </div>
              <div class="pi-enh-tips-row pi-enh-tips-row-meta">
                <span class="pi-enh-tips-meta-label">${touchDesc}</span>
              </div>
            </div>
          `.trim();
        }
        return `
          <div class="pi-enh-tips-content is-desktop">
            <div class="pi-enh-tips-row pi-enh-tips-row-actions">
              <span class="pi-enh-tips-action-item"><span class="pi-enh-tips-badge">滚轮 / 双指滑</span>调粗细</span>
              <span class="pi-enh-tips-divider">·</span>
              <span class="pi-enh-tips-action-item"><span class="pi-enh-tips-badge">${undoShortcut}</span>撤销 (30次)</span>
              <span class="pi-enh-tips-divider">·</span>
              <span class="pi-enh-tips-meta-label">${memoryDesc}</span>
            </div>
          </div>
        `.trim();
      };

      const tipsBanner = document.createElement("div");
      tipsBanner.className = "pi-enh-image-editor-tips";
      tipsBanner.setAttribute("role", "note");
      tipsBanner.setAttribute("aria-label", "快捷功能指引");
      tipsBanner.innerHTML = `
        <span class="pi-enh-tips-icon" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg></span>
        <div class="pi-enh-tips-body">${renderTipsBodyHtml()}</div>
        <button type="button" class="pi-enh-tips-close" title="关闭提示" aria-label="关闭提示">✕</button>
      `.trim();
      tipsBanner.addEventListener("click", (e) => e.stopPropagation());
      tipsBanner.addEventListener("pointerdown", (e) => e.stopPropagation());
      tipsBanner.addEventListener("touchstart", (e) => e.stopPropagation());

      topHud.appendChild(tipsBanner);
      topHud.appendChild(thicknessHud);
      stage.appendChild(topHud);

      const updateTipsUi = () => {
        const body = tipsBanner.querySelector(".pi-enh-tips-body");
        if (body) {
          body.innerHTML = renderTipsBodyHtml();
        }
      };

      if (isTipsDismissed()) {
        tipsBanner.classList.add("is-hidden");
      }

      const controls = document.createElement("div");
      controls.className = "pi-enh-image-editor-controls";
      const tools = document.createElement("div");
      tools.className = "pi-enh-image-editor-tools";
      const actionsRow = document.createElement("div");
      actionsRow.className = "pi-enh-image-editor-actions";
      const status = document.createElement("span");
      status.className = "pi-enh-image-editor-status";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");

      const makeActionButton = (action, label, title, extraClass = "") => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `pi-enh-image-editor-btn ${extraClass}`.trim();
        button.setAttribute("data-image-editor-action", action);
        button.setAttribute("aria-label", title);
        button.title = title;
        button.textContent = label;
        return button;
      };

      const penBtn = makeActionButton("pen", "✍️ 画笔", "自由画笔");
      const rectBtn = makeActionButton("rect", "▭ 矩形", "矩形框标注");
      const cropBtn = makeActionButton("crop", "✂️ 裁剪", "框选裁剪图片");
      const undoBtn = makeActionButton("undo", "↶ 撤销", "撤销上一步 (Ctrl/Cmd+Z)");
      const clearBtn = makeActionButton("clear", "清除", "清除全部标注");
      const cancelBtn = makeActionButton("cancel", "取消", "取消编辑");
      const applyCropBtn = makeActionButton("apply-crop", "✓ 确认裁剪", "确认裁剪选区", "is-crop-confirm");
      const saveBtn = makeActionButton("save", "保存替换", "保存并替换原附件", "is-primary");
      undoBtn.disabled = true;
      clearBtn.disabled = true;
      applyCropBtn.style.display = "none";

      tools.appendChild(penBtn);
      tools.appendChild(rectBtn);
      tools.appendChild(cropBtn);

      const colors = [
        ["#ef4444", "红色"],
        ["#facc15", "黄色"],
        ["#3b82f6", "蓝色"],
        ["#ffffff", "白色"],
      ];
      const colorButtons = [];
      for (const [value, label] of colors) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "pi-enh-image-editor-color";
        button.setAttribute("data-image-editor-color", value);
        button.setAttribute("aria-label", label);
        button.title = label;
        button.style.background = value;
        colorButtons.push(button);
        tools.appendChild(button);
      }

      const widths = [[4, "细"], [8, "中"], [14, "粗"]];
      const widthButtons = [];
      for (const [value, label] of widths) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "pi-enh-image-editor-width";
        button.setAttribute("data-image-editor-width", String(value));
        button.setAttribute("aria-label", `${label}线条`);
        button.title = `${label}线条`;
        button.textContent = label;
        widthButtons.push(button);
        tools.appendChild(button);
      }

      const tipsToggleBtn = makeActionButton("toggle-tips", "指引", "显示/隐藏快捷功能提示");
      if (!isTipsDismissed()) {
        tipsToggleBtn.classList.add("is-active");
        tipsToggleBtn.setAttribute("aria-pressed", "true");
      }
      tools.appendChild(tipsToggleBtn);

      const tipsCloseBtn = tipsBanner.querySelector(".pi-enh-tips-close");
      tipsCloseBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        tipsBanner.classList.add("is-hidden");
        try {
          localStorage.setItem(TIPS_STORAGE_KEY, "true");
        } catch (err) {}
        tipsToggleBtn.classList.remove("is-active");
        tipsToggleBtn.setAttribute("aria-pressed", "false");
      });

      tipsToggleBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const willShow = tipsBanner.classList.contains("is-hidden");
        if (willShow) {
          tipsBanner.classList.remove("is-hidden");
          tipsToggleBtn.classList.add("is-active");
          tipsToggleBtn.setAttribute("aria-pressed", "true");
          try {
            localStorage.removeItem(TIPS_STORAGE_KEY);
          } catch (err) {}
        } else {
          tipsBanner.classList.add("is-hidden");
          tipsToggleBtn.classList.remove("is-active");
          tipsToggleBtn.setAttribute("aria-pressed", "false");
          try {
            localStorage.setItem(TIPS_STORAGE_KEY, "true");
          } catch (err) {}
        }
      });

      actionsRow.appendChild(undoBtn);
      actionsRow.appendChild(clearBtn);
      actionsRow.appendChild(cancelBtn);
      actionsRow.appendChild(applyCropBtn);
      actionsRow.appendChild(saveBtn);
      controls.appendChild(tools);
      controls.appendChild(actionsRow);
      controls.appendChild(status);
      editor.appendChild(stage);
      editor.appendChild(controls);
      dialog.appendChild(editor);
      editorRoot = editor;

      const ctx = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
      let sourceImage = document.createElement("img");
      const sourceUrl = editContext?.editSrc || src;
      const MAX_UNDO_STEPS = 50;
      let drawing = false;
      let activePointerId = null;
      let draftAction = null;
      let activeAction = null;
      let cropBox = null;
      let actions = [];
      let saving = false;
      let hudTimeout = null;
      let isTwoFingerGesture = false;
      let twoFingerStartY = 0;
      let twoFingerStartWidth = lineWidth;
      let lastTwoFingerTime = 0;

      function normalizeRect(p1, p2) {
        const x = Math.max(0, Math.min(p1.x, p2.x));
        const y = Math.max(0, Math.min(p1.y, p2.y));
        const w = Math.min(canvas.width - x, Math.abs(p2.x - p1.x));
        const h = Math.min(canvas.height - y, Math.abs(p2.y - p1.y));
        return { x, y, w, h };
      }

      function selectTool(nextTool, persist = false) {
        abandonActiveDraft();
        tool = nextTool;
        if (persist) {
          saveTool(tool);
          updateTipsUi();
        }
        penBtn.setAttribute("aria-pressed", String(tool === "pen"));
        rectBtn.setAttribute("aria-pressed", String(tool === "rect"));
        cropBtn.setAttribute("aria-pressed", String(tool === "crop"));
        penBtn.classList?.[tool === "pen" ? "add" : "remove"]?.("is-active");
        rectBtn.classList?.[tool === "rect" ? "add" : "remove"]?.("is-active");
        cropBtn.classList?.[tool === "crop" ? "add" : "remove"]?.("is-active");
        if (tool !== "crop") {
          cropBox = null;
          if (applyCropBtn) applyCropBtn.style.display = "none";
        }
        status.textContent = getToolHintStatus(tool);
        redraw();
      }

      function canvasUnitsPerCssPixel() {
        const rect = canvas.getBoundingClientRect?.();
        if (!rect || !rect.width || !canvas.width) return 1;
        return canvas.width / rect.width;
      }

      function visibleLineWidthToCanvasUnits(width) {
        return Math.max(1, width * canvasUnitsPerCssPixel());
      }

      function showThicknessFeedback() {
        const dot = thicknessHud.querySelector?.(".pi-enh-hud-dot");
        const text = thicknessHud.querySelector?.(".pi-enh-hud-text");
        if (dot) {
          const dotSize = Math.max(4, Math.min(28, lineWidth));
          dot.style.width = `${dotSize}px`;
          dot.style.height = `${dotSize}px`;
          dot.style.background = color;
        }
        if (text) text.textContent = `${lineWidth}px`;
        thicknessHud.classList.add("is-visible");
        if (hudTimeout) clearTimeout(hudTimeout);
        hudTimeout = setTimeout(() => thicknessHud.classList.remove("is-visible"), 1000);
      }

      function currentEditableAction() {
        if (activeAction && actions.includes(activeAction) && activeAction.type !== "crop") {
          return activeAction;
        }
        for (let index = actions.length - 1; index >= 0; index--) {
          if (actions[index]?.type !== "crop") return actions[index];
        }
        return null;
      }

      function selectColor(nextColor, updateCurrent = true) {
        color = nextColor;
        for (const button of colorButtons) {
          const active = button.getAttribute("data-image-editor-color") === color;
          button.setAttribute("aria-pressed", String(active));
          button.classList?.[active ? "add" : "remove"]?.("is-active");
        }
        const dot = thicknessHud.querySelector?.(".pi-enh-hud-dot");
        if (dot) dot.style.background = color;
        if (updateCurrent) {
          const target = draftAction && draftAction.type !== "crop" ? draftAction : currentEditableAction();
          if (target) {
            target.color = color;
            redraw();
          }
        }
      }

      function selectWidth(nextWidth, showFeedback = false, updateCurrent = true, persist = false) {
        lineWidth = Math.max(1, Math.min(48, Math.round(nextWidth)));
        if (persist) {
          saveLineWidth(lineWidth);
          updateTipsUi();
        }
        for (const button of widthButtons) {
          const active = Number(button.getAttribute("data-image-editor-width")) === lineWidth;
          button.setAttribute("aria-pressed", String(active));
          button.classList?.[active ? "add" : "remove"]?.("is-active");
        }
        if (updateCurrent) {
          const target = draftAction && draftAction.type !== "crop" ? draftAction : currentEditableAction();
          if (target) {
            target.lineWidth = lineWidth;
            redraw();
          }
        }
        if (showFeedback) showThicknessFeedback();
      }

      function drawAction(action) {
        if (!ctx || !action) return;
        ctx.save?.();
        ctx.strokeStyle = action.color;
        // 与 kx_image_preview 一样按显示层即时反馈：lineWidth 表示屏幕可见像素，
        // 高清原图缩小显示时换算成 Canvas 内部单位，避免 HUD 20px、肉眼却只有几像素。
        ctx.lineWidth = visibleLineWidthToCanvasUnits(action.lineWidth);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        if (action.type === "rect") {
          const width = action.end.x - action.start.x;
          const height = action.end.y - action.start.y;
          ctx.strokeRect?.(action.start.x, action.start.y, width, height);
        } else if (action.points.length) {
          ctx.beginPath?.();
          ctx.moveTo?.(action.points[0].x, action.points[0].y);
          for (const point of action.points.slice(1)) ctx.lineTo?.(point.x, point.y);
          if (action.points.length === 1) ctx.lineTo?.(action.points[0].x + 0.01, action.points[0].y + 0.01);
          ctx.stroke?.();
        }
        ctx.restore?.();
      }

      function redraw(includePreview = true) {
        if (!ctx || !canvas.width || !canvas.height) return;
        ctx.clearRect?.(0, 0, canvas.width, canvas.height);
        ctx.drawImage?.(sourceImage, 0, 0, canvas.width, canvas.height);
        for (const action of actions) {
          if (action.type !== "crop") drawAction(action);
        }
        if (includePreview && draftAction && draftAction.type !== "crop") drawAction(draftAction);

        // 裁剪辅助选区与半透明遮罩
        const activeCrop = includePreview ? (cropBox || (draftAction?.type === "crop" ? normalizeRect(draftAction.start, draftAction.end) : null)) : null;
        if (activeCrop && activeCrop.w > 2 && activeCrop.h > 2) {
          ctx.save?.();
          // 外围半透明暗色遮罩
          ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
          if (typeof ctx.fill === "function" && typeof ctx.rect === "function") {
            ctx.beginPath?.();
            ctx.rect(0, 0, canvas.width, canvas.height);
            ctx.rect(activeCrop.x, activeCrop.y, activeCrop.w, activeCrop.h);
            ctx.fill("evenodd");
          }
          // 亮蓝色虚线边框
          ctx.strokeStyle = "#38bdf8";
          ctx.lineWidth = 2;
          if (typeof ctx.setLineDash === "function") ctx.setLineDash([6, 4]);
          ctx.strokeRect?.(activeCrop.x, activeCrop.y, activeCrop.w, activeCrop.h);

          // 四角手柄高亮
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 3;
          if (typeof ctx.setLineDash === "function") ctx.setLineDash([]);
          const cornerLen = Math.min(16, Math.min(activeCrop.w, activeCrop.h) / 3);
          ctx.beginPath?.();
          ctx.moveTo?.(activeCrop.x, activeCrop.y + cornerLen);
          ctx.lineTo?.(activeCrop.x, activeCrop.y);
          ctx.lineTo?.(activeCrop.x + cornerLen, activeCrop.y);
          ctx.moveTo?.(activeCrop.x + activeCrop.w - cornerLen, activeCrop.y);
          ctx.lineTo?.(activeCrop.x + activeCrop.w, activeCrop.y);
          ctx.lineTo?.(activeCrop.x + activeCrop.w, activeCrop.y + cornerLen);
          ctx.moveTo?.(activeCrop.x + activeCrop.w, activeCrop.y + activeCrop.h - cornerLen);
          ctx.lineTo?.(activeCrop.x + activeCrop.w, activeCrop.y + activeCrop.h);
          ctx.lineTo?.(activeCrop.x + activeCrop.w - cornerLen, activeCrop.y + activeCrop.h);
          ctx.moveTo?.(activeCrop.x + cornerLen, activeCrop.y + activeCrop.h);
          ctx.lineTo?.(activeCrop.x, activeCrop.y + activeCrop.h);
          ctx.lineTo?.(activeCrop.x, activeCrop.y + activeCrop.h - cornerLen);
          ctx.stroke?.();
          ctx.restore?.();
        }
      }

      function updateHistoryButtons() {
        const empty = actions.length === 0;
        undoBtn.disabled = empty;
        clearBtn.disabled = empty;
      }

      function pointFromEvent(event) {
        const rect = canvas.getBoundingClientRect();
        const width = rect.width || 1;
        const height = rect.height || 1;
        return {
          x: Math.max(0, Math.min(canvas.width, ((event.clientX || 0) - rect.left) * canvas.width / width)),
          y: Math.max(0, Math.min(canvas.height, ((event.clientY || 0) - rect.top) * canvas.height / height)),
        };
      }

      function isActivePointer(event) {
        return (event?.pointerId ?? null) === activePointerId;
      }

      function abandonActiveDraft(event = null) {
        if (event && !isActivePointer(event)) return;
        if (!drawing || !draftAction) return;
        const pointerId = activePointerId;
        drawing = false;
        activePointerId = null;
        draftAction = null;
        if (pointerId !== null) {
          try { canvas.releasePointerCapture?.(pointerId); } catch (error) {}
        }
        redraw();
      }

      function hasMinimumRectDrag(action) {
        const bounds = canvas.getBoundingClientRect?.();
        const minCanvasWidth = 4 * (canvas.width || 1) / (bounds?.width || 1);
        const minCanvasHeight = 4 * (canvas.height || 1) / (bounds?.height || 1);
        return Math.abs(action.end.x - action.start.x) >= minCanvasWidth
          && Math.abs(action.end.y - action.start.y) >= minCanvasHeight;
      }

      const onPointerDown = (event) => {
        if (isTwoFingerGesture || Date.now() - lastTwoFingerTime < 320) return;
        if (drawing) return;
        if (event.pointerType === "touch" && !event.isPrimary) return;
        if (event.button !== undefined && event.button !== 0) return;
        event.preventDefault?.();
        event.stopPropagation?.();
        activePointerId = event.pointerId ?? null;
        drawing = true;
        const point = pointFromEvent(event);
        if (tool === "crop") {
          cropBox = null;
          if (applyCropBtn) applyCropBtn.style.display = "none";
          draftAction = { type: "crop", start: point, end: point };
        } else if (tool === "rect") {
          draftAction = { type: "rect", start: point, end: point, color, lineWidth };
        } else {
          draftAction = { type: "pen", points: [point], color, lineWidth };
        }
        try { canvas.setPointerCapture?.(event.pointerId); } catch (error) {}
        redraw();
      };

      const onPointerMove = (event) => {
        if (!drawing || !draftAction || !isActivePointer(event)) return;
        // A missed release must not turn hover motion into a saved annotation.
        if (event.buttons === 0) {
          abandonActiveDraft(event);
          return;
        }
        event.preventDefault?.();
        const point = pointFromEvent(event);
        if (draftAction.type === "crop" || draftAction.type === "rect") {
          draftAction.end = point;
        } else {
          draftAction.points.push(point);
        }
        redraw();
      };

      const onPointerUp = (event) => {
        if (!drawing || !draftAction || !isActivePointer(event)) return;
        event.preventDefault?.();
        drawing = false;
        try { canvas.releasePointerCapture?.(event.pointerId); } catch (error) {}
        activePointerId = null;
        if (draftAction.type === "crop") {
          const box = normalizeRect(draftAction.start, draftAction.end);
          if (box.w >= 16 && box.h >= 16) {
            cropBox = box;
            if (applyCropBtn) {
              applyCropBtn.style.display = "";
              applyCropBtn.disabled = false;
            }
            status.textContent = `裁剪选区：${Math.round(box.w)} × ${Math.round(box.h)}，点击“确认裁剪”`;
          } else {
            cropBox = null;
            if (applyCropBtn) applyCropBtn.style.display = "none";
          }
          draftAction = null;
          redraw();
          return;
        }
        if (draftAction.type === "rect" && !hasMinimumRectDrag(draftAction)) {
          draftAction = null;
          redraw();
          return;
        }
        activeAction = draftAction;
        actions.push(draftAction);
        if (actions.length > MAX_UNDO_STEPS) actions.shift();
        draftAction = null;
        redraw();
        updateHistoryButtons();
        status.textContent = `当前标注 ${lineWidth}px；滚轮或双指上下滑可立即改变实际粗细`;
      };

      const onPointerCancel = (event) => abandonActiveDraft(event);
      const onEditorBlur = () => abandonActiveDraft();

      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("pointercancel", onPointerCancel);
      canvas.addEventListener("lostpointercapture", onPointerCancel);
      window.addEventListener("blur", onEditorBlur);
      editor.addEventListener("click", (event) => event.stopPropagation?.());

      penBtn.addEventListener("click", () => selectTool("pen", true));
      rectBtn.addEventListener("click", () => selectTool("rect", true));
      cropBtn.addEventListener("click", () => selectTool("crop", true));

      function applyCrop() {
        if (!cropBox || cropBox.w < 10 || cropBox.h < 10) return;
        const prevWidth = canvas.width;
        const prevHeight = canvas.height;
        const prevSource = sourceImage;
        const prevActions = actions.slice();

        const tempCanvas = document.createElement("canvas");
        tempCanvas.width = Math.round(cropBox.w);
        tempCanvas.height = Math.round(cropBox.h);
        const tempCtx = tempCanvas.getContext?.("2d");
        if (tempCtx && typeof tempCtx.drawImage === "function") {
          tempCtx.drawImage(
            canvas,
            Math.round(cropBox.x), Math.round(cropBox.y), Math.round(cropBox.w), Math.round(cropBox.h),
            0, 0, Math.round(cropBox.w), Math.round(cropBox.h)
          );
        }
        const croppedUrl = tempCanvas.toDataURL ? tempCanvas.toDataURL("image/png") : sourceUrl;

        const croppedWidth = Math.round(cropBox.w);
        const croppedHeight = Math.round(cropBox.h);

        actions.push({
          type: "crop",
          prevWidth,
          prevHeight,
          prevSource,
          prevActions,
          croppedUrl,
        });
        if (actions.length > MAX_UNDO_STEPS) actions.shift();
        activeAction = null;

        // 立即同步更新画布尺寸与内容，实现零延迟、无闪烁即时裁剪
        canvas.width = croppedWidth;
        canvas.height = croppedHeight;
        if (ctx && typeof ctx.drawImage === "function") {
          try { ctx.drawImage(tempCanvas, 0, 0); } catch (e) {}
        }
        cropBox = null;
        if (applyCropBtn) applyCropBtn.style.display = "none";
        selectTool("rect", false);
        updateHistoryButtons();
        updateTipsUi();
        status.textContent = "已完成裁剪，可继续标注或直接保存替换";

        const nextImg = document.createElement("img");
        nextImg.onload = () => {
          sourceImage = nextImg;
          redraw();
        };
        nextImg.src = croppedUrl;
        if (nextImg.complete) nextImg.onload();
      }

      applyCropBtn.addEventListener("click", applyCrop);

      for (const button of colorButtons) {
        button.addEventListener("click", () => selectColor(button.getAttribute("data-image-editor-color")));
      }
      for (const button of widthButtons) {
        button.addEventListener("click", () => selectWidth(Number(button.getAttribute("data-image-editor-width")), true, true, true));
      }

      const undo = () => {
        abandonActiveDraft();
        if (!actions.length) return;
        const last = actions.pop();
        if (last && last.type === "crop") {
          sourceImage = last.prevSource;
          canvas.width = last.prevWidth;
          canvas.height = last.prevHeight;
          cropBox = null;
          if (applyCropBtn) applyCropBtn.style.display = "none";
          status.textContent = "已撤销裁剪，恢复原尺寸";
        } else {
          status.textContent = `已撤销上一步（剩余 ${actions.length} 步）`;
        }
        activeAction = null;
        const previous = currentEditableAction();
        if (previous) {
          activeAction = previous;
          selectColor(previous.color, false);
          selectWidth(previous.lineWidth, false, false, false);
        }
        redraw();
        updateHistoryButtons();
      };

      undoBtn.addEventListener("click", undo);
      clearBtn.addEventListener("click", () => {
        abandonActiveDraft();
        actions = [];
        activeAction = null;
        redraw();
        updateHistoryButtons();
      });

      const hasEdits = () => actions.length > 0;
      let confirmOverlay = null;

      const hideConfirmPrompt = () => {
        if (confirmOverlay) {
          try { confirmOverlay.remove(); } catch (error) {}
          confirmOverlay = null;
        }
      };

      const isPromptActive = () => Boolean(confirmOverlay && confirmOverlay.parentElement);

      async function doSaveAndClose() {
        if (saving) return;
        abandonActiveDraft();
        hideConfirmPrompt();
        if (!actions.length) {
          cleanup();
          return;
        }
        saving = true;
        saveBtn.disabled = true;
        status.textContent = "正在保存…";
        try {
          // Draft shapes and crop guides belong to the preview, never the PNG.
          redraw(false);
          const dataUrl = canvas.toDataURL("image/png");
          const data = dataUrl.split(",")[1] || "";
          const byteLength = Math.floor(data.length * 3 / 4);
          if (!data || byteLength > 10 * 1024 * 1024) throw new Error("标注后的图片超过 10 MB，请减少标注或缩小原图");
          const replacement = { data, mimeType: "image/png", previewUrl: dataUrl };
          let replaced = false;
          if (typeof editContext?.replace === "function") {
            replaced = await editContext.replace(replacement) !== false;
          } else if (editContext && Number.isInteger(editContext.index)) {
            const native = readNativeComposerDraft();
            replaced = replaceComposerImageState(native, editContext.index, editContext.expectedImage, replacement);
            if (replaced) editContext.expectedImage = native.imagesRef.current[editContext.index];
          } else {
            const downloadLink = document.createElement("a");
            downloadLink.href = dataUrl;
            downloadLink.download = (alt || "annotated-image").replace(/[^\w.-]/g, "_") + "-annotated.png";
            downloadLink.target = "_blank";
            document.body.appendChild(downloadLink);
            downloadLink.click();
            downloadLink.remove();
            replaced = true;
          }
          if (!replaced) throw new Error("无法安全定位原附件，已保留原图，请重新打开后再试");
          img.src = dataUrl;
          img.setAttribute?.("src", dataUrl);
          if (items[currentIndex]) {
            items[currentIndex].src = dataUrl;
            if (items[currentIndex].editContext) {
              items[currentIndex].editContext.editSrc = dataUrl;
            }
            const targetDomImg = items[currentIndex].domElement;
            if (editContext && targetDomImg) {
              targetDomImg.src = dataUrl;
              targetDomImg.setAttribute?.("src", dataUrl);
            }
          }
          if (editContext) editContext.editSrc = dataUrl;
          cleanup();
          showToast(editContext ? "标注已保存并替换原图" : "标注图片已下载到本地");
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : String(error);
        } finally {
          saving = false;
          saveBtn.disabled = false;
        }
      }

      const showConfirmPrompt = () => {
        if (isPromptActive()) return;
        const overlay = document.createElement("div");
        overlay.className = "pi-enh-image-confirm-overlay";
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-label", "确认保存修改");

        const isMobile = typeof isMobileEnvironment === "function" ? isMobileEnvironment() : Boolean(
          typeof window !== "undefined" && (
            (window.matchMedia && window.matchMedia("(max-width: 600px), (hover: none)").matches)
            || ("ontouchstart" in window)
            || (window.navigator?.maxTouchPoints > 0 && window.innerWidth <= 800)
          )
        );

        const card = document.createElement("div");
        card.className = "pi-enh-image-confirm-card";

        const title = document.createElement("div");
        title.className = "pi-enh-image-confirm-title";
        title.textContent = "是否保存对图片的修改？";

        const hint = document.createElement("div");
        hint.className = "pi-enh-image-confirm-hint";

        const actionsWrap = document.createElement("div");
        actionsWrap.className = "pi-enh-image-confirm-actions";

        const saveConfirmBtn = document.createElement("button");
        saveConfirmBtn.type = "button";
        saveConfirmBtn.className = "pi-enh-image-confirm-btn is-save";
        saveConfirmBtn.setAttribute("data-confirm-action", "save");

        const discardBtn = document.createElement("button");
        discardBtn.type = "button";
        discardBtn.className = "pi-enh-image-confirm-btn is-discard";
        discardBtn.setAttribute("data-confirm-action", "discard");

        if (isMobile) {
          hint.textContent = "未保存的标注修改将被丢弃";
          saveConfirmBtn.textContent = editContext ? "保存并替换" : "保存下载";
          discardBtn.textContent = "不保存退出";
        } else {
          hint.innerHTML = '按 <kbd>空格</kbd> 确认保存并替换，按 <kbd>ESC</kbd> 放弃修改';
          saveConfirmBtn.textContent = editContext ? "保存并替换 (空格)" : "保存下载 (空格)";
          discardBtn.textContent = "不保存退出 (Esc)";
        }

        saveConfirmBtn.addEventListener("click", (ev) => {
          ev.stopPropagation?.();
          doSaveAndClose();
        });

        discardBtn.addEventListener("click", (ev) => {
          ev.stopPropagation?.();
          hideConfirmPrompt();
          cleanup();
        });

        const continueBtn = document.createElement("button");
        continueBtn.type = "button";
        continueBtn.className = "pi-enh-image-confirm-btn is-cancel";
        continueBtn.setAttribute("data-confirm-action", "cancel");
        continueBtn.textContent = "继续编辑";
        continueBtn.addEventListener("click", (ev) => {
          ev.stopPropagation?.();
          hideConfirmPrompt();
        });

        actionsWrap.appendChild(saveConfirmBtn);
        actionsWrap.appendChild(discardBtn);
        actionsWrap.appendChild(continueBtn);

        card.appendChild(title);
        card.appendChild(hint);
        card.appendChild(actionsWrap);
        overlay.appendChild(card);

        overlay.addEventListener("click", (ev) => {
          if (ev.target === overlay) {
            ev.stopPropagation?.();
            hideConfirmPrompt();
          }
        });

        editor.appendChild(overlay);
        confirmOverlay = overlay;
      };

      cancelBtn.addEventListener("click", (ev) => {
        ev.stopPropagation?.();
        if (hasEdits()) {
          showConfirmPrompt();
        } else {
          cleanup();
        }
      });

      saveBtn.addEventListener("click", (ev) => {
        ev.stopPropagation?.();
        doSaveAndClose();
      });

      editorController = {
        hasEdits,
        promptExit: showConfirmPrompt,
        dismissPrompt: hideConfirmPrompt,
        isPromptActive,
        saveAndClose: doSaveAndClose,
      };

      const initializeCanvas = () => {
        const width = sourceImage.naturalWidth || 1;
        const height = sourceImage.naturalHeight || 1;
        canvas.width = width;
        canvas.height = height;
        redraw();
        status.textContent = getToolHintStatus(tool);
      };
      sourceImage.addEventListener("load", initializeCanvas, { once: true });
      sourceImage.addEventListener("error", () => {
        status.textContent = "图片载入失败，原图未修改";
        saveBtn.disabled = true;
      }, { once: true });
      sourceImage.src = sourceUrl;
      sourceImage.setAttribute?.("src", sourceUrl);
      if (sourceImage.complete && sourceImage.naturalWidth) initializeCanvas();

      // 参考 Odoo kx_image_preview：在显示容器直接拦截 wheel，立即更新显示层并阻止页面滚动。
      const onEditorWheel = (event) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        const step = event.shiftKey ? 1 : 2;
        selectWidth(lineWidth + ((event.deltaY || 0) < 0 ? step : -step), true, true, true);
        status.textContent = `当前标注实际可见粗细：${lineWidth}px`;
      };

      const onThicknessTouchStart = (event) => {
        if (!event.touches || event.touches.length !== 2) return;
        event.preventDefault?.();
        event.stopPropagation?.();
        if (drawing) {
          abandonActiveDraft();
        }
        isTwoFingerGesture = true;
        twoFingerStartY = (event.touches[0].clientY + event.touches[1].clientY) / 2;
        twoFingerStartWidth = lineWidth;
        showThicknessFeedback();
      };

      const onThicknessTouchMove = (event) => {
        if (!isTwoFingerGesture || !event.touches || event.touches.length !== 2) return;
        event.preventDefault?.();
        event.stopPropagation?.();
        const currentY = (event.touches[0].clientY + event.touches[1].clientY) / 2;
        const change = Math.round((twoFingerStartY - currentY) / 6);
        selectWidth(twoFingerStartWidth + change, true, true, true);
        status.textContent = `当前标注实际可见粗细：${lineWidth}px`;
      };

      const onThicknessTouchEnd = (event) => {
        if (!isTwoFingerGesture) return;
        if (!event.touches || event.touches.length < 2) {
          isTwoFingerGesture = false;
          lastTwoFingerTime = Date.now();
        }
      };

      const onEditorKeyDown = (event) => {
        if ((event.ctrlKey || event.metaKey)
          && (event.key === "z" || event.key === "Z" || event.code === "KeyZ")) {
          event.preventDefault?.();
          event.stopPropagation?.();
          undo();
        }
      };

      stage.addEventListener("wheel", onEditorWheel, { passive: false });
      stage.addEventListener("touchstart", onThicknessTouchStart, { passive: false });
      stage.addEventListener("touchmove", onThicknessTouchMove, { passive: false });
      stage.addEventListener("touchend", onThicknessTouchEnd, { passive: true });
      stage.addEventListener("touchcancel", onThicknessTouchEnd, { passive: true });
      window.addEventListener("keydown", onEditorKeyDown, true);

      selectTool(tool, false);
      selectColor(color, false);
      selectWidth(lineWidth, false, false, false);
      disposeEditor = () => {
        hideConfirmPrompt();
        editorController = null;
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerup", onPointerUp);
        canvas.removeEventListener("pointercancel", onPointerCancel);
        canvas.removeEventListener("lostpointercapture", onPointerCancel);
        window.removeEventListener("blur", onEditorBlur);
        stage.removeEventListener("wheel", onEditorWheel);
        stage.removeEventListener("touchstart", onThicknessTouchStart);
        stage.removeEventListener("touchmove", onThicknessTouchMove);
        stage.removeEventListener("touchend", onThicknessTouchEnd);
        stage.removeEventListener("touchcancel", onThicknessTouchEnd);
        window.removeEventListener("keydown", onEditorKeyDown, true);
        if (hudTimeout) clearTimeout(hudTimeout);
      };
    }

    function updateTransform(withTransition = true) {
      if (!img || !img.style) return;
      img.style.transition = withTransition ? "transform 0.08s ease-out" : "none";
      img.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
      if (indicator) {
        indicator.textContent = `${Math.round(scale * 100)}%`;
      }
      if (scale > 1) {
        img.style.cursor = isDragging ? "grabbing" : "grab";
      } else {
        img.style.cursor = "grab";
      }
    }

    function applyZoom(delta, originX = null, originY = null) {
      const prevScale = scale;
      const newScale = Math.min(6.0, Math.max(0.4, Number((scale + delta).toFixed(2))));
      if (newScale === prevScale) return;

      if (originX !== null && originY !== null && typeof img.getBoundingClientRect === "function") {
        const rect = img.getBoundingClientRect();
        if (rect && rect.width) {
          const mouseX = originX - (rect.left + rect.width / 2);
          const mouseY = originY - (rect.top + rect.height / 2);
          const ratio = newScale / prevScale - 1;
          translateX -= mouseX * ratio;
          translateY -= mouseY * ratio;
        }
      }

      scale = newScale;
      if (scale <= 1) {
        translateX = translateX * 0.5;
        translateY = translateY * 0.5;
        if (Math.abs(scale - 1) < 0.05) {
          scale = 1;
          translateX = 0;
          translateY = 0;
        }
      }
      updateTransform(true);
    }

    function resetZoom() {
      scale = 1;
      translateX = 0;
      translateY = 0;
      updateTransform(true);
    }

    // 缩放按钮交互
    zoomInBtn.addEventListener("click", (e) => {
      e.stopPropagation?.();
      applyZoom(0.2);
    });
    zoomOutBtn.addEventListener("click", (e) => {
      e.stopPropagation?.();
      applyZoom(-0.2);
    });
    indicator.addEventListener("click", (e) => {
      e.stopPropagation?.();
      resetZoom();
    });
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation?.();
      enterImageEditor();
    });
    toolbar.addEventListener("click", (e) => {
      e.stopPropagation?.();
    });

    // 双击重置 / 双击放大
    img.addEventListener("dblclick", (e) => {
      e.stopPropagation?.();
      if (editorRoot) return;
      if (scale > 1.05) {
        resetZoom();
      } else {
        applyZoom(1.0, e.clientX, e.clientY);
      }
    });

    // 鼠标滚轮缩放
    const onWheel = (e) => {
      if (editorRoot) return;
      if (typeof e.preventDefault === "function") e.preventDefault();
      if (typeof e.stopPropagation === "function") e.stopPropagation();
      const delta = (e.deltaY || 0) < 0 ? 0.15 : -0.15;
      applyZoom(delta, e.clientX, e.clientY);
    };
    dialog.addEventListener("wheel", onWheel, { passive: false });

    // 鼠标拖拽平移
    const onMouseDown = (e) => {
      if (editorRoot) return;
      if (e.button !== 0 && e.button !== undefined) return; // 仅限左键
      isDragging = true;
      hasDragged = false;
      dragStartX = e.clientX || 0;
      dragStartY = e.clientY || 0;
      initialTranslateX = translateX;
      initialTranslateY = translateY;
      img.classList?.add?.("is-dragging");
      updateTransform(false);
      if (typeof e.preventDefault === "function") e.preventDefault();
    };

    const onMouseMove = (e) => {
      if (!isDragging) return;
      const dx = (e.clientX || 0) - dragStartX;
      const dy = (e.clientY || 0) - dragStartY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        hasDragged = true;
      }
      translateX = initialTranslateX + dx;
      translateY = initialTranslateY + dy;
      updateTransform(false);
    };

    const onMouseUp = () => {
      if (!isDragging) return;
      isDragging = false;
      img.classList?.remove?.("is-dragging");
      updateTransform(true);
    };

    img.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    const handleModalEscape = () => {
      if (editorController && editorController.isPromptActive()) {
        cleanup();
        return;
      }
      if (editorController && editorController.hasEdits()) {
        editorController.promptExit();
        return;
      }
      cleanup();
    };

    const onGlobalModalKeyDown = (e) => {
      if (e.key === "Escape" || e.keyCode === 27) {
        e.preventDefault?.();
        e.stopPropagation?.();
        handleModalEscape();
      }
    };
    window.addEventListener("keydown", onGlobalModalKeyDown, true);

    const cleanup = () => {
      if (dialog.__piEnhCleanup === null) return;
      addHistoryImageOperation++;
      try { addHistoryImageAbortController?.abort(); } catch (e) {}
      addHistoryImageAbortController = null;
      isAddingHistoryImage = false;
      dialog.__piEnhCleanup = null;
      dialog.__piEnhHandleEscape = null;
      window.removeEventListener("keydown", onGlobalModalKeyDown, true);
      window.removeEventListener("popstate", onPopState);
      if (historyPushed) {
        historyPushed = false;
        try {
          window.history.back();
        } catch (e) {}
      }
      leaveImageEditor();
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      if (document.body.style) {
        document.body.style.overflow = prevOverflow || "";
      }
      if (dialog.open && typeof dialog.close === "function") {
        try { dialog.close(); } catch (e) {}
      }
      try { dialog.remove(); } catch (e) {}
      if (deps.activeZoomDialog === dialog) {
        deps.activeZoomDialog = null;
      }
      try {
        if (previousActiveElement && typeof previousActiveElement.focus === "function") {
          previousActiveElement.focus({ preventScroll: true });
        }
      } catch (e) {}
    };
    dialog.__piEnhCleanup = cleanup;
    dialog.__piEnhHandleEscape = handleModalEscape;

    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation?.();
      if (editorController && editorController.hasEdits()) {
        editorController.promptExit();
      } else {
        cleanup();
      }
    });

    dialog.addEventListener("click", (e) => {
      if (editorController && editorController.isPromptActive()) return;
      if (hasDragged) {
        hasDragged = false;
        return;
      }
      // The second click of a queue-thumbnail double-click can land on the new backdrop.
      if (options?.source === "queue" && performance.now() - modalOpenedAt < 250) return;
      if (e.target === dialog) {
        if (editorController && editorController.hasEdits()) {
          editorController.promptExit();
        } else {
          cleanup();
        }
      }
    });

    dialog.addEventListener("keydown", (e) => {
      if (editorController && editorController.isPromptActive()) {
        if (e.key === " " || e.code === "Space" || e.key === "Enter") {
          e.preventDefault?.();
          e.stopPropagation?.();
          editorController.saveAndClose();
          return;
        }
        if (e.key === "Escape" || e.keyCode === 27) {
          e.preventDefault?.();
          e.stopPropagation?.();
          cleanup();
          return;
        }
        return;
      }

      if (e.key === "Escape" || e.keyCode === 27) {
        e.preventDefault?.();
        e.stopPropagation?.();
        handleModalEscape();
        return;
      } else if (!editorRoot && (e.key === "+" || e.key === "=")) {
        e.preventDefault?.();
        applyZoom(0.2);
      } else if (!editorRoot && (e.key === "-" || e.key === "_")) {
        e.preventDefault?.();
        applyZoom(-0.2);
      } else if (!editorRoot && (e.key === "0" || e.key === "r" || e.key === "R")) {
        e.preventDefault?.();
        resetZoom();
      } else if (e.key === "ArrowLeft" || e.key === "Left") {
        e.preventDefault?.();
        e.stopPropagation?.();
        switchTo(currentIndex - 1);
      } else if (e.key === "ArrowRight" || e.key === "Right") {
        e.preventDefault?.();
        e.stopPropagation?.();
        switchTo(currentIndex + 1);
      }
    });

    // 手机触摸手势：左右轻扫切图 (Swipe Left/Right)
    let touchStartX = 0;
    let touchStartY = 0;
    let touchStartTime = 0;

    const onTouchStart = (e) => {
      e.stopPropagation?.();
      const t = e.changedTouches?.[0] || e.touches?.[0];
      if (!t) return;
      touchStartX = t.clientX || 0;
      touchStartY = t.clientY || 0;
      touchStartTime = Date.now();
    };

    const onTouchMove = (e) => {
      e.stopPropagation?.();
    };

    const onTouchEnd = (e) => {
      e.stopPropagation?.();
      if (editorRoot) return;
      if (scale > 1.05) return; // 处于放大状态时让位给平移拖拽
      const t = e.changedTouches?.[0] || e.touches?.[0];
      if (!t) return;
      const dx = (t.clientX || 0) - touchStartX;
      const dy = (t.clientY || 0) - touchStartY;
      const dt = Date.now() - touchStartTime;
      if (Math.abs(dx) > 35 && Math.abs(dx) > Math.abs(dy) * 1.25 && dt < 650) {
        if (dx < 0) {
          switchTo(currentIndex + 1);
        } else {
          switchTo(currentIndex - 1);
        }
      }
    };

    dialog.addEventListener("touchstart", onTouchStart, { passive: true });
    dialog.addEventListener("touchmove", onTouchMove, { passive: true });
    dialog.addEventListener("touchend", onTouchEnd, { passive: true });

    dialog.addEventListener("cancel", (e) => {
      e.preventDefault?.();
      cleanup();
    });

    if (typeof dialog.showModal === "function") {
      try {
        dialog.showModal();
      } catch (e) {
        dialog.setAttribute("open", "");
      }
    } else {
      dialog.setAttribute("open", "");
    }

    try {
      dialog.focus?.({ preventScroll: true });
    } catch (e) {}
    try {
      closeBtn.focus?.({ preventScroll: true });
    } catch (e) {}

    updateGalleryUi();
    updateTransform(false);

    // 默认进入编辑状态，除非显式指定 autoEdit: false
    const autoEdit = options?.autoEdit !== false;
    if (autoEdit) {
      enterImageEditor();
    }
  };
  } };
})(window);
