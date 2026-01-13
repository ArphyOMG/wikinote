// Cornell Note Seed App (React + Tiptap + Firebase)
// -----------------------------------------------------------------------------
// 기획자님을 위해 파이어베이스(Firebase) DB와 연결된 버전입니다.
// 이제 데이터가 구글 서버에 저장되므로, 어디서 접속해도 똑같은 노트를 볼 수 있습니다.
// -----------------------------------------------------------------------------

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";

// [1] 파이어베이스 추가
import { initializeApp } from "firebase/app";
// ★★★ [중요] query를 firestoreQuery로 이름 변경 (충돌 방지) ★★★
import { getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot, query as firestoreQuery, orderBy } from "firebase/firestore";

// --- 파이어베이스 설정 ---
const firebaseConfig = {
  apiKey: "AIzaSyAwxaLsgOVoPclbbPR0gMl4ivFTOBm2YVk",
  authDomain: "wikinote-e6127.firebaseapp.com",
  projectId: "wikinote-e6127",
  storageBucket: "wikinote-e6127.firebasestorage.app",
  messagingSenderId: "474564012678",
  appId: "1:474564012678:web:936c5da38f5f387f753f07"
};

// 앱과 DB 시작!
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// --- Brand -----------------------------------------------------------------
const BRAND_ICON = "✏️";
const BRAND_TITLE = "WikiNote (Cloud)";

// --- Utilities -----------------------------------------------------------
function uid() {
  try { if (typeof crypto !== "undefined" && crypto?.randomUUID) return crypto.randomUUID(); } catch (_) {}
  return "id_" + Math.random().toString(36).slice(2);
}

function nowISO() { return new Date().toISOString(); }
function ensureStringHTML(v) { return typeof v === "string" ? v : "<p></p>"; }
function stripTags(html = "") { if (typeof window === "undefined") return String(html).replace(/<[^>]*>/g," ").trim(); const d=document.createElement("div"); d.innerHTML=ensureStringHTML(html); return (d.textContent||"").trim(); }
function tokenize(q="") { return q.toLowerCase().split(/\s+/).map(s=>s.trim()).filter(Boolean); }

// --- LLM API (local backend proxy: /api -> http://localhost:4000) ----------
const API_BASE = "/api";

async function apiPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `API Error (${res.status})`;
    throw new Error(msg);
  }
  return json;
}

function clampToOneSentence(text = "") {
  const t = String(text).replace(/\s+/g, " ").trim();
  if (t.length <= 0) return "";
  // 첫 문장만 추출(한국어/영문 단순 처리)
  const m = t.match(/^(.+?[.!?。])\s/);
  if (m?.[1]) return m[1].trim();
  return t;
}

function sectionsToHTML(sections = []) {
  return sections.map(s => `<section><h3>${s.cue||""}</h3>${ensureStringHTML(s.html)}</section>`).join("\n");
}

function noteToDocumentPayload(note) {
  // Backend 검색 인덱싱용: cue/notes/summary를 평문으로 전달
  const notesText = (note.sections || [])
    .map(s => `${s.cue || ""}
${stripTags(ensureStringHTML(s.html))}`.trim())
    .filter(Boolean)
    .join("\n\n");

  return {
    doc_id: note.id,
    title: note.title || "Untitled",
    notebook_id: "default",
    tags: note.tags || [],
    contentBySection: {
      cue: (note.cue || "").trim(),
      notes: notesText,
      summary: (note.summary || "").trim(),
    },
  };
}

function createEmptyNote() {
  return { id: uid(), title: "새 노트", cue: "", sections: [], summary: "", tags: [], unit: "", createdAt: nowISO(), updatedAt: nowISO(), notesHTML: "", notesText: "" };
}

function useDebouncedEffect(effect,deps,delay=600){ useEffect(()=>{const h=setTimeout(effect,delay); return ()=>clearTimeout(h);},[...deps,delay]); }

// --- Main App ------------------------------------------------------------
export default function App(){
  const [notes, setNotes] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const selected = useMemo(() => notes.find(n => n.id === selectedId) || null, [notes, selectedId]);
  
  // 여기서 사용하는 'query'는 검색어를 뜻하는 변수입니다. (파이어베이스 query 아님!)
  const [query, setQuery] = useState("");
  const [tagInput, setTagInput] = useState("");

  // --- LLM: Claim Links Panel state ---------------------------------------
  const [llmOpen, setLlmOpen] = useState(false);
  const [llmBusy, setLlmBusy] = useState(false);
  const [llmMsg, setLlmMsg] = useState("");
  const [activeClaim, setActiveClaim] = useState(null);
  const [evidenceCandidates, setEvidenceCandidates] = useState([]);
  const [includeChunkIds, setIncludeChunkIds] = useState(new Set());
  const [suggestions, setSuggestions] = useState([]);

  // [3] DB 실시간 연결
  useEffect(() => {
    // ★★★ [중요] 아까 위에서 바꾼 이름(firestoreQuery)을 사용합니다 ★★★
    const q = firestoreQuery(collection(db, "notes"), orderBy("updatedAt", "desc"));
    
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const loadedNotes = snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }));
      setNotes(loadedNotes);
      if (!selectedId && loadedNotes.length > 0) {
        setSelectedId(loadedNotes[0].id);
      }
    });
    return () => unsubscribe();
  }, []); 

  // [4] 자동 저장
  useDebouncedEffect(() => {
    if (selected) {
      const docRef = doc(db, "notes", selected.id);
      setDoc(docRef, selected)
        .then(async () => {
          console.log("자동 저장 완료:", selected.title);
          // LLM 검색/RAG를 위한 백엔드 인덱싱(베스트-에포트)
          try {
            await apiPost("/v1/documents:upsert", noteToDocumentPayload(selected));
          } catch (e) {
            console.warn("백엔드 인덱싱 실패(무시 가능):", e.message);
          }
        })
        .catch(err => console.error("저장 실패:", err));
    }
  }, [selected], 800);

  const addTag = (raw) => {
    if (!selected) return;
    const t = (raw || "").trim();
    if (!t) return;
    const uniq = Array.from(new Set([...(selected.tags || []), t]));
    updateSelected({ tags: uniq });
    setTagInput("");
  };
  
  const removeTag = (t) => {
    if (!selected) return;
    updateSelected({ tags: (selected.tags || []).filter(x => x !== t) });
  };

  const deleteSelectedNote = async () => {
    if (!selected) return;
    const ok = window.confirm("정말 이 노트를 삭제하시겠습니까? (DB에서 완전히 삭제됩니다)");
    if (!ok) return;
    try {
      await deleteDoc(doc(db, "notes", selected.id));
      setSelectedId(null); 
    } catch (e) {
      alert("삭제 실패: " + e.message);
    }
  };

  const createNewNote = async () => {
    const n = createEmptyNote();
    try {
      await setDoc(doc(db, "notes", n.id), n);
      setSelectedId(n.id);
    } catch (e) {
      alert("생성 실패: " + e.message);
    }
  };

  function truncateTitle(str, maxLength = 7) {
    if (!str) return "";
    return str.length > maxLength ? str.slice(0, maxLength) + "…" : str;
  }

  useEffect(()=>{
    if(selected){
      document.title = `${truncateTitle(selected.title, 7)} - ✏️WikiNote`;
    } else {
      document.title = "✏️WikiNote";
    }
  },[selected]);
   
  const updateSelected=(patch)=>{
    if(!selected) return;
    let next={...selected,...patch};

    if(Object.prototype.hasOwnProperty.call(patch, "cue")){
      const lines=(patch.cue||"").split(/\n+/);
      const prev=selected.sections||[];
      const newSections = lines.map((line,i)=>{
        const s = prev[i];
        if(s) return { ...s, cue: line };
        return { id: uid(), cue: line, html: "<p></p>", text: "", collapsed: false };
      });
      for(let i=lines.length;i<prev.length;i++){
        const s = prev[i];
        if(stripTags(s.html)===""){
          continue;
        } else {
          newSections.push({ ...s, cue: "" });
        }
      }
      next.sections = newSections;
    }

    next.notesHTML=sectionsToHTML(next.sections||[]);
    next.notesText=(next.sections||[]).map(s=>`${s.cue}\n${stripTags(s.html)}`).join("\n\n");
    next.updatedAt=nowISO();
    setNotes(prev=>prev.map(n=>n.id===selected.id?next:n));
  };

  const updateSection=(id,patch)=>{
    if(!selected) return;
    const sections=(selected.sections||[]).map(s=>s.id===id?{...s,...patch}:s);
    const next={...selected,sections,notesHTML:sectionsToHTML(sections),notesText:sections.map(s=>`${s.cue}\n${stripTags(s.html)}`).join("\n\n"),updatedAt:nowISO()};
    setNotes(prev=>prev.map(n=>n.id===selected.id?next:n));
  };

  const reorderSections=(result)=>{
    if(!result.destination || !selected) return;
    const sections=Array.from(selected.sections||[]);
    const [removed]=sections.splice(result.source.index,1);
    sections.splice(result.destination.index,0,removed);
    updateSelected({sections});
  };

  const filtered=useMemo(()=>{const tks=tokenize(query); return notes.filter(n=>tks.every(t=>JSON.stringify(n).toLowerCase().includes(t)));},[notes,query]);

  return (
    <div className="h-full w-full p-4 grid grid-rows-[auto,1fr] gap-4 bg-gray-50">
<header className="flex items-center justify-between gap-3 bg-white p-2 rounded-xl shadow">
  <div className="flex items-center gap-2 px-1 select-none">
    <span className="text-2xl" aria-hidden>{BRAND_ICON}</span>
    <span className="text-lg font-bold tracking-tight">{BRAND_TITLE}</span>
  </div>
  <div className="flex items-center gap-2 flex-1">
    <input
      value={query}
      onChange={e=>setQuery(e.target.value)}
      placeholder="노트 전체에서 검색"
      className="px-3 py-2 flex-1 bg-gray-100 rounded-xl"
    />
      <button
        onClick={createNewNote}
        className="px-3 py-2 bg-blue-500 text-white rounded-xl"
      >+ 새 노트</button>
      <button
        onClick={deleteSelectedNote}
        disabled={!selected}
        className="px-3 py-2 bg-red-500 text-white rounded-xl disabled:opacity-50"
      >노트 삭제</button>

  </div>
</header>

      <main className="grid grid-cols-4 gap-4">
        <aside className="col-span-1 bg-white rounded-xl shadow p-2 overflow-y-auto">
          {filtered.length === 0 && <div className="p-4 text-center text-gray-400">노트가 없습니다.<br/>새 노트를 추가해보세요!</div>}
          {filtered.map(n=>(
            <div key={n.id} onClick={()=>setSelectedId(n.id)} className={`p-2 border rounded mb-2 cursor-pointer ${selectedId===n.id?"bg-blue-100 border-blue-400":"hover:bg-gray-50"}`}>
              <div className="font-medium">{n.title||"(제목없음)"}</div>
              <div className="text-xs text-gray-500 line-clamp-2">{(n.sections||[]).map(s=>s.cue).filter(Boolean).slice(0,3).join(" • ")}</div>
            </div>
          ))}
        </aside>

        <section className="col-span-3 bg-white rounded-xl shadow p-3 flex flex-col">
          {selected && (
            <>
              <input value={selected.title} onChange={e=>updateSelected({title:e.target.value})} className="text-lg font-semibold border-b mb-2 outline-none" placeholder="노트 제목" />
<div className="mb-2">
  <label className="text-sm text-gray-600">태그</label>
  <div className="mt-1 flex flex-wrap gap-2">
    {(selected.tags || []).map(t => (
      <span key={t} className="inline-flex items-center gap-1 bg-gray-100 border rounded-xl px-2 py-1 text-sm">
        #{t}
        <button
          onClick={()=>removeTag(t)}
          className="text-gray-500 hover:text-gray-800"
          title="태그 제거"
        >×</button>
      </span>
    ))}
    <input
      value={tagInput}
      onChange={e=>setTagInput(e.target.value)}
      onKeyDown={e=>{
        if (e.key === "Enter" || e.key === ",") {
          e.preventDefault();
          addTag(tagInput.replace(/,/, ""));
        }
      }}
      placeholder="태그 입력 후 Enter (예: 통계)"
      className="px-2 py-1 border rounded-xl text-sm"
    />
  </div>
</div>

              <label className="text-sm text-gray-600 mb-1">질문/키워드 (한 줄 = 한 섹션 제목)</label>
              <textarea value={selected.cue} onChange={e=>updateSelected({cue:e.target.value})} placeholder="예) 왜 3의 배수 규칙이 성립하죠?\n예) 좌극한/우극한 차이는?" className="w-full mb-3 p-2 border rounded resize-y min-h-[6rem]" />

              <DragDropContext onDragEnd={reorderSections}>
                <Droppable droppableId="sections">
                  {(provided)=> (
                    <div {...provided.droppableProps} ref={provided.innerRef} className="flex-1 overflow-y-auto">
                      {(selected.sections||[]).length===0 && (
                        <div className="p-4 text-sm text-gray-500">좌측에 질문/키워드를 입력하면 섹션이 생성됩니다.</div>
                      )}

                      {(selected.sections||[]).map((sec,idx)=>(
                        <Draggable key={sec.id} draggableId={sec.id} index={idx}>
                          {(p)=> (
                            <div ref={p.innerRef} {...p.draggableProps} className="border rounded mb-3">
                              <div className="flex items-center justify-between bg-gray-50 p-2" {...p.dragHandleProps}>
                                <div className="font-semibold">{sec.cue||"(제목없음)"}</div>
                                <div className="flex items-center gap-2">
                                  <button
                                    onClick={()=>updateSection(sec.id,{collapsed:!sec.collapsed})}
                                    className="text-xs px-2 py-1 border rounded"
                                  >
                                    {sec.collapsed?"펼치기":"접기"}
                                  </button>
                                  <button
                                    onClick={()=>deleteSection(sec.id)}
                                    className="text-xs px-2 py-1 border rounded border-red-300 text-red-600"
                                    title="섹션 삭제"
                                  >
                                    삭제
                                  </button>
                                </div>
                              </div>
                              {!sec.collapsed && (
                                <SectionEditor section={sec} onChange={(patch)=>updateSection(sec.id,patch)} noteId={selected.id} onOpenLinks={async (payload)=>{
                                  setLlmMsg("");
                                  setLlmBusy(true);
                                  try {
                                    // Claim upsert
                                    const sentence = clampToOneSentence(payload.text);
                                    const clientKey = `${payload.noteId}:${payload.sectionId}:${payload.from}:${payload.to}`;
                                    const up = await apiPost("/v1/claims:upsert", {
                                      doc_id: payload.noteId,
                                      section: "notes",
                                      pos_from: payload.from,
                                      pos_to: payload.to,
                                      sentence_text: sentence,
                                      client_claim_key: clientKey,
                                    });
                                    setActiveClaim(up.claim);
                                    setLlmOpen(true);
                                    // Evidence search
                                    const ev = await apiPost("/v1/evidence:search", {
                                      seed: { type: "claim", claim_id: up.claim.claim_id },
                                      scope: { notebook_id: "default", include_sections: ["cue","notes","summary"] },
                                      top_k: 12,
                                      strategy: "hybrid",
                                    });
                                    setEvidenceCandidates(ev.evidence_candidates || []);
                                    const defaults = new Set((ev.evidence_candidates || []).slice(0,5).map(x=>x.chunk_id));
                                    setIncludeChunkIds(defaults);
                                    setSuggestions([]);
                                  } catch (e) {
                                    setLlmMsg(e.message);
                                  } finally {
                                    setLlmBusy(false);
                                  }
                                }} />
                              )}
                            </div>
                          )}
                        </Draggable>
                      ))}
                      {provided.placeholder}
                    </div>
                  )}
                </Droppable>
              </DragDropContext>

              <label className="text-sm text-gray-600 mt-3 mb-1">요약</label>
              <textarea value={selected.summary} onChange={e=>updateSelected({summary:e.target.value})} placeholder="핵심 내용을 3~5문장으로 요약" className="p-2 border rounded min-h-[5rem]" />
              <Diagnostics selected={selected} />

              {llmOpen && (
                <LLMLinksPanel
                  open={llmOpen}
                  onClose={() => setLlmOpen(false)}
                  busy={llmBusy}
                  message={llmMsg}
                  claim={activeClaim}
                  evidenceCandidates={evidenceCandidates}
                  includeChunkIds={includeChunkIds}
                  setIncludeChunkIds={setIncludeChunkIds}
                  suggestions={suggestions}
                  setSuggestions={setSuggestions}
                  onSuggest={async () => {
                    if (!activeClaim) return;
                    setLlmBusy(true);
                    setLlmMsg("");
                    try {
                      const include = Array.from(includeChunkIds);
                      if (include.length === 0) throw new Error("근거 청크를 최소 1개 선택해야 합니다.");
                      const sug = await apiPost("/v1/relations:suggest", {
                        from_claim_id: activeClaim.claim_id,
                        evidence: { include_chunk_ids: include, exclude_chunk_ids: [] },
                        options: { max_suggestions: 5, must_include_evidence: true, tone: "concise" },
                      });
                      setSuggestions(sug.suggestions || []);
                    } catch (e) {
                      setLlmMsg(e.message);
                    } finally {
                      setLlmBusy(false);
                    }
                  }}
                  onApprove={async (s) => {
                    if (!activeClaim) return;
                    setLlmBusy(true);
                    setLlmMsg("");
                    try {
                      const clientKey = `draft:${s.to_claim_draft.doc_id}:${s.to_claim_draft.section}:${(s.to_claim_draft.sentence_text||"").slice(0,32)}`;
                      const resp = await apiPost("/v1/relations:approve", {
                        from_claim_id: activeClaim.claim_id,
                        to_claim: {
                          doc_id: s.to_claim_draft.doc_id,
                          section: s.to_claim_draft.section,
                          pos_from: s.to_claim_draft.pos_from ?? 0,
                          pos_to: s.to_claim_draft.pos_to ?? (s.to_claim_draft.sentence_text || "").length,
                          sentence_text: s.to_claim_draft.sentence_text,
                          client_claim_key: clientKey,
                        },
                        relation: {
                          type: s.type,
                          explanation: s.explanation_one_liner,
                          confidence: s.confidence,
                        },
                        evidence: (s.evidence || []).map(e => ({
                          chunk_id: e.chunk_id,
                          quote: e.quote,
                          pos_from: null,
                          pos_to: null,
                        })),
                      });
                      setLlmMsg(`저장 완료: ${resp.relation?.relation_id || ""}`);
                    } catch (e) {
                      setLlmMsg(e.message);
                    } finally {
                      setLlmBusy(false);
                    }
                  }}
                />
              )}
            </>
          )}
        </section>
      </main>
    </div>
  );
}

function SectionEditor({section,onChange,noteId,onOpenLinks}){
  const fileRef = useRef(null);
  const editor=useEditor({
    extensions:[
      StarterKit.configure({ bulletList:{keepMarks:true}, orderedList:{keepMarks:true} }),
      Placeholder.configure({placeholder:"내용 입력"}),
      Image.configure({allowBase64:true}),
      Link.configure({ openOnClick:true, autolink:true, linkOnPaste:true }),
    ],
    content:ensureStringHTML(section.html),
    onUpdate:({editor})=>{onChange({html:editor.getHTML(),text:editor.getText()});},
    editorProps:{attributes:{class:"tiptap prose max-w-none min-h-[6rem] p-2 focus:outline-none"}},
  });
  useEffect(()=>{ if(editor){ try{ editor.commands.setContent(ensureStringHTML(section.html),false); }catch(e){ editor.commands.setContent("<p></p>",false); } } },[section.id]);

  const [sel, setSel] = useState({ text: "", from: 0, to: 0 });
  useEffect(() => {
    if (!editor) return;
    const update = () => {
      const { from, to } = editor.state.selection;
      const t = editor.state.doc.textBetween(from, to, "\n").trim();
      setSel({ text: t, from, to });
    };
    editor.on("selectionUpdate", update);
    editor.on("transaction", update);
    update();
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("transaction", update);
    };
  }, [editor]);
  const openImagePicker=()=>fileRef.current?.click();
  const onPickImage=(e)=>{ const f=e.target.files?.[0]; if(!f) return; const r=new FileReader(); r.onload=()=>{ const src=r.result; if(typeof src==="string") editor?.chain().focus().setImage({src}).run(); e.target.value=""; }; r.readAsDataURL(f); };
  return (
    <div className="px-2 py-2">
      <div className="flex items-center gap-1 mb-2">
        <ToolbarButton active={editor?.isActive("bold")} onClick={()=>editor?.chain().focus().toggleBold().run()}>굵게</ToolbarButton>
        <ToolbarButton active={editor?.isActive("italic")} onClick={()=>editor?.chain().focus().toggleItalic().run()}>기울임</ToolbarButton>
        <ToolbarButton onClick={()=>editor?.chain().focus().toggleBulletList().run()}>• 리스트</ToolbarButton>
        <ToolbarButton onClick={()=>editor?.chain().focus().toggleOrderedList().run()}>1. 리스트</ToolbarButton>
        <ToolbarButton onClick={openImagePicker}>🖼️ 이미지</ToolbarButton>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPickImage} />
        <div className="flex-1" />
        <ToolbarButton
          onMouseDown={(e) => {
          e.preventDefault(); // selection 유지 핵심
          if (!onOpenLinks || !editor) return;

          const { from, to } = editor.state.selection;
          const t = editor.state.doc.textBetween(from, to, "\n").trim();
          if (!t || t.length < 5) return;

          onOpenLinks({ noteId, sectionId: section.id, from, to, text: t });
        }}
      >
        🔗 연결 보기
      </ToolbarButton>

        <div className="mx-2 w-px h-5 bg-gray-300" />
        <ToolbarButton onClick={()=>{ const url=prompt("링크 URL"); if(url) editor?.chain().focus().extendMarkRange("link").setLink({href:url}).run(); }}>🔗 링크</ToolbarButton>
        <ToolbarButton onClick={()=>editor?.chain().focus().unsetLink().run()}>링크 해제</ToolbarButton>
      </div>
      <EditorContent editor={editor}/>
    </div>
  );
}

function ToolbarButton({ children, active, ...props }) {
  return (
    <button
      type="button"
      {...props}
      className={`px-2 py-1 text-sm rounded-md border ${active ? "bg-blue-100 border-blue-300" : "bg-white border-gray-300"}`}
    >
      {children}
    </button>
  );
}


function Diagnostics({ selected }){
  const [results,setResults]=useState([]);
  useEffect(()=>{
    const r=[];
    try{
      const before={ sections:[ {id:"a",cue:"Q1",html:"<p>x</p>"}, {id:"b",cue:"Q2",html:"<p>y</p>"} ] };
      const cueChanged="New1\nNew2\nNew3";
      const lines=cueChanged.split(/\n+/);
      const prev=before.sections;
      const newSections=lines.map((line,i)=> prev[i]?{...prev[i],cue:line}:{id:"new_"+i,cue:line,html:"<p></p>",text:""});
      for(let i=lines.length;i<prev.length;i++){ const s=prev[i]; if(stripTags(s.html)!=="") newSections.push({...s,cue:""}); }
      const ok = newSections[0].id==="a" && newSections[1].id==="b" && newSections[2].cue==="New3";
      r.push([ok, "Index mapping preserves existing by index; new gets appended"]);
    }catch(e){ r.push([false, "Index mapping threw: "+e?.message]); }
    try{
      const prev=[ {id:"a",cue:"Q1",html:"<p></p>"}, {id:"b",cue:"Q2",html:"<p>has</p>"} ];
      const lines=["OnlyOne"]; 
      const res=[...lines.map((l,i)=> prev[i]?{...prev[i],cue:l}:{id:uid(),cue:l,html:"<p></p>"})];
      for(let i=lines.length;i<prev.length;i++){ const s=prev[i]; if(stripTags(s.html)!=="") res.push({...s,cue:""}); }
      const ok = res.length===2 && res[0].cue==="OnlyOne" && res[1].cue==="" && stripTags(res[1].html)==="has";
      r.push([ok, "Cue deletion rule: drop empty, keep content as untitled"]);
    }catch(e){ r.push([false, "Deletion rule test threw: "+e?.message]); }
    try{
      const arr=[{id:"a"},{id:"b"},{id:"c"}];
      const [x]=arr.splice(0,1); arr.splice(2,0,x);
      r.push([arr.map(s=>s.id).join("")==="bca", "Reorder moves item correctly"]);
    }catch(e){ r.push([false, "Reorder test threw: "+e?.message]); }
    try{
      const s={id:"a",collapsed:false};
      const toggled={...s,collapsed:!s.collapsed};
      r.push([toggled.collapsed===true, "Collapse toggles true→false"]);
    }catch(e){ r.push([false, "Collapse test threw: "+e?.message]); }
    setResults(r);
  },[selected?.id]);
  return (
    <details className="mt-3 text-sm text-gray-600">
      <summary>진단 / 테스트 ({results.filter(([ok])=>ok).length}/{results.length} 통과)</summary>
      <ul className="list-disc ml-5 mt-2 space-y-1">
        {results.map(([ok,msg],i)=>(<li key={i} className={ok?"text-green-700":"text-red-700"}>{ok?"✔":"✖"} {msg}</li>))}
      </ul>
    </details>
  );
}


function LLMLinksPanel({
  open,
  onClose,
  busy,
  message,
  claim,
  evidenceCandidates,
  includeChunkIds,
  setIncludeChunkIds,
  suggestions,
  onSuggest,
  onApprove,
}) {
  if (!open) return null;
  return (
    <div className="fixed top-0 right-0 h-full w-[420px] bg-white border-l shadow-lg z-50 flex flex-col">
      <div className="p-3 border-b flex items-center justify-between">
        <div className="font-semibold">문장 연결 (LLM)</div>
        <button className="text-sm px-2 py-1 border rounded" onClick={onClose}>닫기</button>
      </div>

      <div className="p-3 text-sm text-gray-700 border-b">
        <div className="text-xs text-gray-500 mb-1">기준 Claim</div>
        <div className="font-medium">{claim?.sentence_text || "-"}</div>
        {message ? <div className="mt-2 text-red-600">{message}</div> : null}
        {busy ? <div className="mt-2 text-gray-500">처리 중…</div> : null}
      </div>

      <div className="p-3 overflow-auto flex-1">
        <div className="flex items-center justify-between mb-2">
          <div className="font-semibold text-sm">근거 선택</div>
          <button
            className="text-sm px-2 py-1 border rounded disabled:opacity-50"
            onClick={onSuggest}
            disabled={busy || !claim}
          >
            관계 제안 생성
          </button>
        </div>

        <div className="space-y-2">
          {(evidenceCandidates || []).map((c) => {
            const checked = includeChunkIds?.has?.(c.chunk_id);
            return (
              <label key={c.chunk_id} className="block border rounded p-2">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!!checked}
                    onChange={(e) => {
                      const next = new Set(includeChunkIds || []);
                      if (e.target.checked) next.add(c.chunk_id);
                      else next.delete(c.chunk_id);
                      setIncludeChunkIds(next);
                    }}
                  />
                  <div className="text-xs text-gray-500">
                    {c.doc_title} / {c.section} (score: {c.score})
                  </div>
                </div>
                <div className="mt-1 text-xs text-gray-700 line-clamp-3">{c.snippet}</div>
              </label>
            );
          })}
          {(evidenceCandidates || []).length === 0 ? (
            <div className="text-sm text-gray-500">근거 후보가 없습니다.</div>
          ) : null}
        </div>

        <div className="mt-4">
          <div className="font-semibold text-sm mb-2">관계 제안</div>
          <div className="space-y-3">
            {(suggestions || []).map((s) => (
              <div key={s.suggestion_id} className="border rounded p-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-xs text-gray-500">
                      type: <b>{s.type}</b> / confidence: <b>{s.confidence}</b>
                    </div>
                    <div className="mt-1 text-sm">
                      <b>To</b>: {s.to_claim_draft?.sentence_text}
                    </div>
                    <div className="mt-1 text-xs text-gray-700">{s.explanation_one_liner}</div>
                  </div>
                  <button
                    className="text-sm px-2 py-1 border rounded disabled:opacity-50"
                    onClick={() => onApprove?.(s)}
                    disabled={busy}
                  >
                    승인
                  </button>
                </div>

                <div className="mt-2">
                  <div className="text-xs text-gray-500 mb-1">근거 인용</div>
                  <ul className="list-disc pl-5 space-y-1">
                    {(s.evidence || []).map((e, idx) => (
                      <li key={idx} className="text-xs text-gray-700">
                        <span className="text-gray-500">{e.chunk_id}: </span>
                        {e.quote}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ))}
            {(suggestions || []).length === 0 ? (
              <div className="text-sm text-gray-500">아직 제안이 없습니다.</div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
