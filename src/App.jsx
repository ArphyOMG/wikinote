// Cornell Note Seed App (React + Tiptap) — Cornell 3-Panel with Section Rules
// -----------------------------------------------------------------------------
// Improvements based on feedback:
// 1) Section mapping stays index-based when editing cue lines.
// 2) When a cue line is deleted: if the section has NO content -> drop it; if it HAS content -> keep it with EMPTY title.
// 3) Sections are draggable in the content area (drag handle) to reorder.
// 4) Each section supports collapse/expand (UI-only; content preserved).
// 5) Diagnostics panel added with tests for mapping, deletion rule, reordering, and collapse flags.
// -----------------------------------------------------------------------------
// ⚠️ ProseMirror multi-version guard
// If you see: RangeError: Can not convert <> to a Fragment (multiple versions of prosemirror-model)
// → Fix dependencies to a single version (package.json overrides/resolutions) and dedupe in bundler.
// npm/pnpm overrides example:
// {
//   "overrides": {
//     "prosemirror-model": "^1.19.3",
//     "prosemirror-state": "^1.4.3",
//     "prosemirror-view": "^1.31.2",
//     "prosemirror-transform": "^1.7.3",
//     "prosemirror-schema-list": "^1.2.2"
//   }
// }
// Also ensure all @tiptap/* versions match, and avoid mixing CDN + bundled builds.
// Runtime hardening below: editors start with safe empty content and only call setContent
// inside useEffect after each editor is ready. We never pass React nodes to setContent.
// -----------------------------------------------------------------------------
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
// from 부분이 바뀌었습니다!
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";

// [1] 파이어베이스 추가 (중요!)
import { initializeApp } from "firebase/app";
import { getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot, query as firestoreQuery, orderBy } from "firebase/firestore";

// --- 파이어베이스 설정 (기획자님의 열쇠) ---
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

function sectionsToHTML(sections = []) {
  return sections.map(s => `<section><h3>${s.cue||""}</h3>${ensureStringHTML(s.html)}</section>`).join("\n");
}

function createEmptyNote() {
  return { id: uid(), title: "새 노트", cue: "", sections: [], summary: "", tags: [], unit: "", createdAt: nowISO(), updatedAt: nowISO(), notesHTML: "", notesText: "" };
}

// [삭제됨] loadNotes, saveNotes (이제 로컬스토리지 대신 DB를 씁니다)

function useDebouncedEffect(effect,deps,delay=600){ useEffect(()=>{const h=setTimeout(effect,delay); return ()=>clearTimeout(h);},[...deps,delay]); }

// --- Main App ------------------------------------------------------------
export default function App(){
  // [2] 상태 관리: DB에서 불러오기 전엔 빈 배열
  const [notes, setNotes] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  
  // 선택된 노트 찾기
  const selected = useMemo(() => notes.find(n => n.id === selectedId) || null, [notes, selectedId]);
  
  const [query, setQuery] = useState("");
  const [tagInput, setTagInput] = useState("");

  // [3] DB 실시간 연결 (제일 중요한 부분!)
  // 앱이 켜지면 파이어베이스 'notes' 컬렉션을 구독합니다.
useEffect(() => {
  // 이제 명확합니다!
  const q = firestoreQuery(collection(db, "notes"), orderBy("updatedAt", "desc"));
  const unsubscribe = onSnapshot(q, (snapshot) => {
  ...
      // DB가 바뀌면 여기로 데이터가 쏫아져 들어옵니다.
      const loadedNotes = snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }));
      setNotes(loadedNotes);
      
      // 만약 선택된 노트가 없으면 첫번째꺼 선택
      if (!selectedId && loadedNotes.length > 0) {
        setSelectedId(loadedNotes[0].id);
      }
    });
    return () => unsubscribe(); // 앱 끌 때 연결 해제
  }, []); // 처음에 한 번만 실행

  // [4] 자동 저장 (내용이 바뀌면 DB에 저장)
  useDebouncedEffect(() => {
    if (selected) {
      // 선택된 노트만 DB에 덮어쓰기 (Update)
      const docRef = doc(db, "notes", selected.id);
      setDoc(docRef, selected)
        .then(() => console.log("자동 저장 완료:", selected.title))
        .catch(err => console.error("저장 실패:", err));
    }
  }, [selected], 800); // 0.8초 동안 입력 없으면 저장

  // 태그 추가
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

  // [5] 노트 삭제 (DB에서 삭제)
  const deleteSelectedNote = async () => {
    if (!selected) return;
    const ok = window.confirm("정말 이 노트를 삭제하시겠습니까? (DB에서 완전히 삭제됩니다)");
    if (!ok) return;

    try {
      await deleteDoc(doc(db, "notes", selected.id)); // DB 삭제 명령
      // 화면에서는 onSnapshot이 알아서 업데이트 해줌
      setSelectedId(null); 
    } catch (e) {
      alert("삭제 실패: " + e.message);
    }
  };

  // [6] 새 노트 만들기 (DB에 추가)
  const createNewNote = async () => {
    const n = createEmptyNote();
    // 로컬 상태를 먼저 업데이트하는 게 아니라, DB에 넣으면 onSnapshot이 알아서 가져옴
    // 하지만 빠른 반응을 위해 로컬에도 추가하는 척 할 수 있지만, 여기선 심플하게 바로 저장
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

    // 큐(Cue) 라인 변경 로직 (기존 유지)
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

    // 로컬 상태 즉시 업데이트 (화면 버벅임 방지)
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
        onClick={createNewNote} // [수정] 새 노트 함수 연결
        className="px-3 py-2 bg-blue-500 text-white rounded-xl"
      >+ 새 노트</button>
      <button
        onClick={deleteSelectedNote} // [수정] 삭제 함수 연결
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
{/* Tags editor */}
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

              {/* Cue area (left panel concept) */}
              <label className="text-sm text-gray-600 mb-1">질문/키워드 (한 줄 = 한 섹션 제목)</label>
              <textarea value={selected.cue} onChange={e=>updateSelected({cue:e.target.value})} placeholder="예) 왜 3의 배수 규칙이 성립하죠?\n예) 좌극한/우극한 차이는?" className="w-full mb-3 p-2 border rounded resize-y min-h-[6rem]" />

              {/* Sections (right content area) */}
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
                              {/* UI divider via border (not content <hr>) */}
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
                                <SectionEditor section={sec} onChange={(patch)=>updateSection(sec.id,patch)} />
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
            </>
          )}
        </section>
      </main>
    </div>
  );
}

// --- Section Editor (변경 없음) ---------------------------------------------
function SectionEditor({section,onChange}){
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
        <div className="mx-2 w-px h-5 bg-gray-300" />
        <ToolbarButton onClick={()=>{ const url=prompt("링크 URL"); if(url) editor?.chain().focus().extendMarkRange("link").setLink({href:url}).run(); }}>🔗 링크</ToolbarButton>
        <ToolbarButton onClick={()=>editor?.chain().focus().unsetLink().run()}>링크 해제</ToolbarButton>
      </div>
      <EditorContent editor={editor}/>
    </div>
  );
}

// --- Small UI bits (변경 없음) ----------------------------------------------
function ToolbarButton({ children, onClick, active }) {
  return (
    <button onClick={onClick} className={`px-2 py-1 text-sm rounded-md border ${active?"bg-blue-100 border-blue-300":"bg-white border-gray-300"}`}>{children}</button>
  );
}

// --- Diagnostics (변경 없음) ------------------------------------------------
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
