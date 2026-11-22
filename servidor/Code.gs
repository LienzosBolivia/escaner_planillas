function prop(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) throw new Error("Falta configurar " + key);
  return value;
}
function json(value) { return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON); }
function doGet() { return json({success: false, error: "Se requiere POST autenticado."}); }
function autorizar(d) {
  if (!d.idToken) throw new Error("Falta iniciar sesión.");
  const response = UrlFetchApp.fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + prop("FIREBASE_WEB_API_KEY"), {
    method: "post", contentType: "application/json", payload: JSON.stringify({idToken:d.idToken}), muteHttpExceptions:true
  });
  const user = (JSON.parse(response.getContentText()).users || [])[0];
  if (user && !user.disabled && user.localId === "kaggle-taller" && ["download","upload"].includes(d.action)) return;
  if (!user || user.disabled) throw new Error("Acceso denegado.");
  const acceso = UrlFetchApp.fetch("https://botartes-default-rtdb.firebaseio.com/accesoTaller.json?auth="+encodeURIComponent(d.idToken), {muteHttpExceptions:true});
  if (acceso.getResponseCode() !== 200) throw new Error("Este navegador necesita el enlace vigente del taller.");
}
function archivoDelTaller(folder, id) {
  const file = DriveApp.getFileById(id);
  const parents = file.getParents();
  while (parents.hasNext()) if (parents.next().getId() === folder.getId()) return file;
  throw new Error("Archivo fuera de la carpeta del taller.");
}
function resultado(file) {
  return {success:true, fileId:file.getId(), url:"https://drive.google.com/uc?export=download&id="+file.getId()};
}
function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    autorizar(d);
    if (d.action === "start") {
      if (!/^[1-5]$/.test(String(d.slot)) || !["cpu","gpu"].includes(d.tipo)) throw new Error("Slot o tipo inválido.");
      const lock = LockService.getScriptLock();
      lock.waitLock(15000);
      try {
        const key = "arranque_" + d.slot;
        const cache = CacheService.getScriptCache();
        if (cache.get(key)) return json({success:true, estado:"iniciando"});
        const urlSlot = "https://botartes-default-rtdb.firebaseio.com/servidores/slot_" + d.slot + ".json?auth=" + encodeURIComponent(d.idToken);
        const respuesta = UrlFetchApp.fetch(urlSlot, {headers:{"X-Firebase-ETag":"true"}, muteHttpExceptions:true});
        if (respuesta.getResponseCode() !== 200) throw new Error("Firebase denegó la consulta del servidor.");
        const actual = JSON.parse(respuesta.getContentText()) || {};
        if (actual.sesion_activa) {
          if (Date.now() - Number(actual.actualizado || 0) < 45000) return json({success:true, estado:"activo"});
          const tipos = ["cpu","gpu"].includes(actual.tipo_servidor) ? [actual.tipo_servidor] : ["cpu","gpu"];
          const estados = tipos.map(tipo => estadoKaggle(tipo, d.slot));
          if (estados.includes("activo")) return json({success:true, estado:"activo"});
          if (estados.includes("desconocido") || !estados.includes("terminado")) {
            throw new Error("No se pudo confirmar que la sesión anterior haya terminado. Se conservó el bloqueo.");
          }
          const headers = respuesta.getAllHeaders();
          const etag = headers.ETag || headers.Etag || headers.etag;
          if (!etag) throw new Error("Firebase no permitió comprobar si el bloqueo cambió.");
          const liberar = UrlFetchApp.fetch(urlSlot, {method:"put", contentType:"application/json", headers:{"if-match":etag},
            payload:JSON.stringify({...actual,sesion_activa:"",estado:"apagado",tarea_actual:""}), muteHttpExceptions:true});
          if (liberar.getResponseCode() !== 200) throw new Error("El estado cambió durante la comprobación. Volvé a intentar.");
        }
        cache.put(key,"1",120);
        const ack = triggerKaggleImageServer(d.tipo, String(d.slot));
        return json({...ack, estado:"iniciando", recuperado:Boolean(actual.sesion_activa)});
      } finally { lock.releaseLock(); }
    }
    if (d.action === "upload_imgbb") {
      if (!/^image\//.test(d.mimetype) || typeof d.base64 !== "string" || !d.base64 || d.base64.length > 44000000) {
        throw new Error("Imagen inválida o demasiado grande para ImgBB.");
      }
      const res = UrlFetchApp.fetch("https://api.imgbb.com/1/upload?key="+encodeURIComponent(prop("IMGBB_API_KEY")), {
        method:"post", payload:{image:d.base64}, muteHttpExceptions:true
      });
      const resultadoImg = JSON.parse(res.getContentText());
      const url = resultadoImg.data && resultadoImg.data.url;
      if (res.getResponseCode() !== 200 || !resultadoImg.success || !/^https:\/\/i\.ibb\.co\//.test(url || "")) {
        throw new Error("ImgBB rechazó la foto (HTTP "+res.getResponseCode()+").");
      }
      return json({success:true, url:url, fileId:""});
    }
    const folder = DriveApp.getFolderById(prop("FOLDER_ID"));
    if (d.action === "download" || d.action === "delete") {
      const file = archivoDelTaller(folder,d.fileId);
      if (d.action === "delete") { file.setTrashed(true); return json({success:true}); }
      const blob = file.getBlob();
      if (!/^image\//.test(blob.getContentType())) throw new Error("Se esperaba una imagen.");
      return json({success:true, base64:Utilities.base64Encode(blob.getBytes()), mimetype:blob.getContentType()});
    }
    if (d.action === "upload") {
      if (!/^image\//.test(d.mimetype)) throw new Error("Tipo de imagen inválido.");
      return json(resultado(folder.createFile(Utilities.newBlob(Utilities.base64Decode(d.base64),d.mimetype,d.filename))));
    }
    const id = d.action === "upload_chunk" ? d.filename : d.uploadId;
    if (!/^chunk_[0-9]+_[0-9]+$/.test(id)) throw new Error("Identificador de subida inválido.");
    if (d.action === "upload_chunk") {
      if (!Number.isInteger(d.partIndex) || d.partIndex < 0 || !d.chunkData) throw new Error("Fragmento inválido.");
      return json({success:true,fileId:folder.createFile(id+"_part_"+d.partIndex+".txt",d.chunkData).getId()});
    }
    if (d.action !== "assemble" || !Array.isArray(d.chunkIds) || !d.chunkIds.length || !/^image\//.test(d.mimetype)) throw new Error("Solicitud inválida.");
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      const name = id+"_"+d.filename;
      const existing = folder.getFilesByName(name);
      if (existing.hasNext()) return json(resultado(existing.next()));
      const parts = d.chunkIds.map((fid,i) => {
        const part = archivoDelTaller(folder,fid);
        if (part.getName() !== id+"_part_"+i+".txt" || part.isTrashed()) throw new Error("Fragmento inválido o fuera de orden.");
        return part;
      });
      const file = ensamblar(folder, parts, name, d.mimetype);
      parts.forEach(p=>{try { p.setTrashed(true); } catch(err) { console.warn("Limpieza pendiente"); }});
      return json(resultado(file));
    } finally { lock.releaseLock(); }
  } catch(err) { return json({success:false,error:String(err.message || err)}); }
}
function credencialesKaggle() {
  return "Basic " + Utilities.base64Encode(prop("KAGGLE_USER") + ":" + prop("KAGGLE_KEY"));
}
function slugKaggle(tipo, slot) {
  return "bot-artes-" + tipo + "-slot-" + slot;
}
function estadoKaggle(tipo, slot) {
  const url = "https://www.kaggle.com/api/v1/kernels/status?userName=" + encodeURIComponent(prop("KAGGLE_USER").toLowerCase().trim()) +
    "&kernelSlug=" + encodeURIComponent(slugKaggle(tipo, slot));
  const res = UrlFetchApp.fetch(url, {headers:{Authorization:credencialesKaggle()}, muteHttpExceptions:true});
  if (res.getResponseCode() === 404) return "ausente";
  if (res.getResponseCode() !== 200) return "desconocido";
  let estado;
  try { estado = String(JSON.parse(res.getContentText()).status || "").toLowerCase(); }
  catch { return "desconocido"; }
  if (["running","queued","pending"].includes(estado)) return "activo";
  if (["complete","completed","error","failed","cancelled","canceled"].includes(estado)) return "terminado";
  return "desconocido";
}

function triggerKaggleImageServer(tipo, slot) {
  var url = "https://www.kaggle.com/api/v1/kernels/push";
  var authHeader = credencialesKaggle();
  var enableGpu = (tipo === "gpu");
  
  var cleanUser = prop("KAGGLE_USER").toLowerCase().replace(/\s+/g, '');

  // Cada slot es un kernel de Kaggle totalmente distinto e independiente,
  // así los 5 pueden estar corriendo al mismo tiempo sin pisarse.
  var slugSuffix = slugKaggle(tipo, slot);
  var dynamicSlug = cleanUser + "/" + slugSuffix;
  
  var payload = {
    "slug": dynamicSlug,
    "newTitle": (enableGpu ? "Bot Artes GPU Slot " : "Bot Artes CPU Slot ") + slot,
    "language": "python",
    "kernelType": "notebook",
    "isPrivate": true,
    "enableGpu": enableGpu,
    "enableInternet": true,
    "datasetDataSources": enableGpu
      ? ["christopherrrobin/firebase-bot-credenciales"]
      : ["christopherrrobin/firebase-bot-credenciales", cleanUser + "/arsenal-modelos-ia-edicion",
         cleanUser + "/fondos-estudio", cleanUser + "/mallas-misiones"],
    "text": getNotebookSourceFromDrive(slot, tipo) 
  };

  var headers = {
    "Authorization": authHeader,
    "Content-Type": "application/json"
  };

  var options = {
    "method": "post",
    "headers": headers,
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true 
  };

  try {
    var response = UrlFetchApp.fetch(url, options);
    var responseCode = response.getResponseCode();
    var responseText = response.getContentText();

    if (responseCode !== 200 && responseCode !== 201) throw new Error("Kaggle rechazó el arranque (HTTP " + responseCode + ").");
    return {success: true};
  } catch (error) { throw error; }
}

function getNotebookSourceFromDrive(slot, tipo) {
  var codigoBruto = DriveApp.getFileById(prop("CODIGO_DRIVE_ID")).getBlob().getDataAsString();
  var codigoLimpio = codigoBruto.replace(/^\uFEFF/, '');

  // 🔧 INYECCIÓN AUTOMÁTICA DEL SLOT:
  // Reemplaza la línea "SLOT = "..."" del código guardado en Drive por el
  // slot que pidió esta pestaña. Así el mismo archivo de Drive sirve para
  // las 5 pestañas, sin tener que editarlo a mano cada vez.
  var slotRegex = /SLOT\s*=\s*"[^"]*"/;
  if (slotRegex.test(codigoLimpio)) {
    codigoLimpio = codigoLimpio.replace(slotRegex, 'SLOT = "' + slot + '"');
  } else {
    // Si por algún motivo no encuentra la línea, la agrega al principio
    codigoLimpio = 'SLOT = "' + slot + '"\n' + codigoLimpio;
  }
  
  var reloj = "# Señal enviada el: " + new Date().toISOString() + " | Slot: " + slot + "\n";
  var codigoFinal = reloj + "FIREBASE_WEB_API_KEY = " + JSON.stringify(prop("FIREBASE_WEB_API_KEY")) + "\nAPPS_URL = " + JSON.stringify(PropertiesService.getScriptProperties().getProperty("WEB_APP_URL") || ScriptApp.getService().getUrl()) + "\nTIPO_SERVIDOR = " + JSON.stringify(tipo) + "\n" + codigoLimpio;
  
  var celda_archivo = "%%writefile servidor.ipy\n" + codigoFinal;
  var celda_ejecucion = "!ipython servidor.ipy";
  
  return JSON.stringify({
    "cells": [
        { "cell_type": "code", "execution_count": null, "metadata": {}, "outputs": [], "source": [celda_archivo] },
        { "cell_type": "code", "execution_count": null, "metadata": {}, "outputs": [], "source": [celda_ejecucion] }
    ],
    "metadata": { 
        "kernelspec": { "display_name": "Python 3", "language": "python", "name": "python3" }, 
        "language_info": { "name": "python" } 
    },
    "nbformat": 4, 
    "nbformat_minor": 2
  });
}


function ensamblar(folder, parts, name, mime) {
  // Drive exige múltiplos de 256 KiB en todos los envíos excepto el último.
  const step = 256 * 1024;
  const tail = parts[parts.length-1].getBlob().getDataAsString();
  const total = parts.reduce((size,p)=>size + p.getSize(),0) / 4 * 3 - (tail.match(/=*$/)[0].length);
  if (!Number.isSafeInteger(total) || total <= 0) throw new Error("Longitud Base64 inválida.");
  const headers = {Authorization:"Bearer "+ScriptApp.getOAuthToken()};
  const init = UrlFetchApp.fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable", {
    method:"post", headers:headers, contentType:"application/json",
    payload:JSON.stringify({name:name,parents:[folder.getId()],mimeType:mime})
  });
  const h = init.getAllHeaders();
  const uri = h.Location || h.location;
  if (!uri) throw new Error("Drive no inició la transferencia.");
  let buffer = [], offset = 0, fileId;
  parts.forEach((part,i)=>{
    const data = i === parts.length-1 ? tail : part.getBlob().getDataAsString();
    buffer = buffer.concat(Utilities.base64Decode(data));
    const count = i === parts.length-1 ? buffer.length : Math.floor(buffer.length/step)*step;
    if (!count) return;
    const end = offset+count;
    const response = UrlFetchApp.fetch(uri, {method:"put", contentType:mime, followRedirects:false,
      headers:{Authorization:headers.Authorization,"Content-Range":"bytes "+offset+"-"+(end-1)+"/"+total},
      payload:Utilities.newBlob(buffer.slice(0,count)).getBytes(), muteHttpExceptions:true});
    const code = response.getResponseCode();
    if (end === total && (code === 200 || code === 201)) fileId = JSON.parse(response.getContentText()).id;
    else if (end === total || code !== 308) throw new Error("Drive interrumpió el ensamblado (HTTP "+code+").");
    buffer = buffer.slice(count);
    offset = end;
  });
  if (!fileId) throw new Error("Drive no confirmó el archivo final.");
  return DriveApp.getFileById(fileId);
}


// Ejecutar desde el editor del propietario. Copiar ENLACE_TALLER desde las propiedades.
function generarEnlaceTaller() {
  const propiedades = PropertiesService.getScriptProperties();
  const url = (propiedades.getProperty("WEB_APP_URL") || ScriptApp.getService().getUrl() || "").trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) {
    throw new Error("Copiá la URL /exec de Administrar implementaciones y guardala en la propiedad WEB_APP_URL.");
  }
  const clave = Utilities.getUuid().replace(/-/g,"") + Utilities.getUuid().replace(/-/g,"");
  propiedades.setProperty("ENLACE_TALLER", url + "#" + clave);
}
