import {
  Client,
  GatewayIntentBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  InteractionType,
  PermissionFlagsBits,
} from "discord.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "../data/transferencias.json");

function cargarDatos() {
  try {
    if (!fs.existsSync(path.dirname(DATA_FILE))) {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    }
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, JSON.stringify({ transferencias: [] }, null, 2));
    }
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch {
    return { transferencias: [] };
  }
}

function guardarDatos(datos) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(datos, null, 2));
}

const ROLES_SISTEMA = ["squad leader", "squad officer", "admin", "moderador", "mod", "bot", "everyone"];
function esRolSistema(nombre) {
  const n = nombre.toLowerCase();
  return ROLES_SISTEMA.some((s) => n.includes(s));
}

// Solo se quitan roles cuyo nombre contenga algo parecido a "selección"
function esRolSeleccion(nombre) {
  const normalizado = nombre
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // quitar tildes
  return normalizado.includes("selec");
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

function findRoleFuzzy(roles, name) {
  const q = name.toLowerCase().trim();
  let match = roles.find((r) => r.name.toLowerCase() === q);
  if (match) return match;
  match = roles.find(
    (r) => r.name.toLowerCase().includes(q) || q.includes(r.name.toLowerCase())
  );
  if (match) return match;
  let best = null, bestDist = Infinity;
  for (const role of roles) {
    const dist = levenshtein(role.name.toLowerCase(), q);
    if (dist < bestDist) { bestDist = dist; best = role; }
  }
  const threshold = Math.max(3, Math.floor(q.length / 2));
  return bestDist <= threshold ? best : null;
}

function buildTransferDescription({ jugador, pais, rated, equipoOrigen, equipoDestino, confirmado = false, extra = "" }) {
  const SEP  = "━━━━━━━━━━━━━━━━━━━━";
  const SEP2 = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
  const SEP3 = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
  const lines = [
    `:VirtualStreetSoccer: **TRANSFERENCIA** :VirtualStreetSoccer:`,
    "",
    SEP,
    "",
    `:emoji_8:  **COPA AMERICA** :emoji_8:`,
    "",
    `**Nombre del jugador**: ${jugador}`,
    "",
    `**Rated** : ${rated ?? ""}`,
    "",
    `**País**: :emoji_11: ${pais ?? ""} >>>>>`,
    "",
    SEP2,
    "",
    `\`VIRTUAL STREET SOCCER CONVOCADOS :\``,
    SEP3,
  ];
  if (confirmado) lines.push("", "✔ **FICHAJE CONFIRMADO**");
  else lines.push("", "¿Confirmas esta transferencia?");
  if (extra) lines.push(extra);
  return lines.join("\n");
}

function parsearOvrPosicion(raw) {
  if (!raw) return { ovr: null, posicion: null };
  const sep = raw.includes("|") ? "|" : raw.includes("/") ? "/" : null;
  if (sep) {
    const [a, b] = raw.split(sep).map((s) => s.trim());
    return { ovr: a || null, posicion: b || null };
  }
  // Si es solo un número se asume OVR; si no, posición
  return /^\d+$/.test(raw.trim())
    ? { ovr: raw.trim(), posicion: null }
    : { ovr: null, posicion: raw.trim() };
}

// ── Datos en memoria ──────────────────────────────────────────────
// Aguarda apertura de modal
const pendientesModal = new Map();
// Aguarda confirmación del Squad Leader
const pendientes = new Map();
// Aguarda aceptación del jugador (tras confirmar el Squad Leader)
const pendientesAceptacion = new Map();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("clientReady", () => {
  console.log(`✅ Bot conectado como ${client.user.tag}`);
});

client.on("error", (err) => {
  console.error("Error del cliente Discord:", err.message);
});

client.on("interactionCreate", async (interaction) => {
  try {

    // ── /transferir ──────────────────────────────────────────────
    if (interaction.isChatInputCommand() && interaction.commandName === "transferir") {
      const rolesPermitidos = ["squad leader", "squad officer"];
      const tienePermiso = interaction.member.roles.cache.some((rol) =>
        rolesPermitidos.some((p) => {
          const q = rol.name.toLowerCase().trim();
          return q === p || q.includes(p) || p.includes(q) || levenshtein(q, p) <= Math.max(2, Math.floor(p.length / 3));
        })
      );

      if (!tienePermiso) {
        await interaction.reply({
          content: "❌ No tienes permisos. Solo los **Squad Leader** y **Squad Officer** pueden realizar transferencias.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const targetUser = interaction.options.getUser("jugador");
      pendientesModal.set(interaction.user.id, {
        targetUserId: targetUser.id,
        targetDisplayName: targetUser.displayName ?? targetUser.username,
      });

      const modal = new ModalBuilder()
        .setCustomId("modal_transferir")
        .setTitle("Transferencia de Jugador");

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("rated").setLabel("Rated").setStyle(TextInputStyle.Short).setPlaceholder("Ej: 89").setRequired(false)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("pais").setLabel("País del jugador").setStyle(TextInputStyle.Short).setPlaceholder("Ej: Argentina").setRequired(false)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("equipo_destino").setLabel("Equipo / Selección Destino").setStyle(TextInputStyle.Short).setPlaceholder("Ej: Selección Argentina").setRequired(true)
        )
      );

      await interaction.showModal(modal);
      return;
    }

    // ── /historial ───────────────────────────────────────────────
    if (interaction.isChatInputCommand() && interaction.commandName === "historial") {
      const datos = cargarDatos();
      const historial = datos.transferencias;

      if (historial.length === 0) {
        await interaction.reply({ content: "📋 No hay transferencias registradas aún.", flags: MessageFlags.Ephemeral });
        return;
      }

      const ultimas = historial.slice(-10).reverse();
      const embed = new EmbedBuilder()
        .setTitle("📋 Historial de Transferencias")
        .setColor(0x5865f2)
        .setDescription(
          ultimas.map((t, i) =>
            `**${i + 1}.** 🏃 **${t.jugador}**` +
            (t.pais ? ` 🌍 ${t.pais}` : "") +
            (t.rated ? ` | Rated: ${t.rated}` : "") +
            `\n   ${t.equipoOrigen ?? "—"} → ${t.equipoDestino}` +
            `\n   📅 ${t.fecha} | Por: ${t.realizadoPor}`
          ).join("\n\n")
        )
        .setFooter({ text: `Total de transferencias: ${historial.length}` })
        .setTimestamp();

      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    // ── /help ────────────────────────────────────────────────────
    if (interaction.isChatInputCommand() && interaction.commandName === "help") {
      const embed = new EmbedBuilder()
        .setTitle("📖 Comandos del Bot")
        .setColor(0x5865f2)
        .addFields(
          {
            name: "⚽ /transferir @jugador",
            value: "Abre el formulario para transferir un jugador a otro equipo.\n**Requiere:** Rol de Squad Leader o Squad Officer.",
          },
          {
            name: "📋 /historial",
            value: "Muestra las últimas 10 transferencias registradas.",
          },
          {
            name: "📖 /help",
            value: "Muestra este mensaje de ayuda.",
          }
        )
        .setFooter({ text: "El jugador debe aceptar la transferencia desde su DM para que sea efectiva." })
        .setTimestamp();

      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    // ── Modal enviado ────────────────────────────────────────────
    if (interaction.type === InteractionType.ModalSubmit && interaction.customId === "modal_transferir") {
      const preData = pendientesModal.get(interaction.user.id);
      pendientesModal.delete(interaction.user.id);

      if (!preData) {
        await interaction.reply({ content: "⚠️ Ocurrió un error, intenta de nuevo.", flags: MessageFlags.Ephemeral });
        return;
      }

      const equipoDestino = interaction.fields.getTextInputValue("equipo_destino");
      const rated        = interaction.fields.getTextInputValue("rated") || null;
      const pais         = interaction.fields.getTextInputValue("pais") || null;

      const id = `transfer_${Date.now()}_${interaction.user.id}`;
      pendientes.set(id, {
        jugador: preData.targetDisplayName,
        targetUserId: preData.targetUserId,
        equipoDestino,
        rated,
        pais,
        userId: interaction.user.id,
        guildId: interaction.guild.id,
        channelId: interaction.channel.id,
        confirmedBy: interaction.user.username,
      });

      const embed = new EmbedBuilder()
        .setColor(0xffa500)
        .setDescription(
          buildTransferDescription({
            jugador: `<@${preData.targetUserId}>`,
            pais,
            rated,
            equipoOrigen: "Se detectará al confirmar",
            equipoDestino,
            confirmado: false,
            extra: `*Solicitado por ${interaction.user.username}*`,
          })
        )
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`confirmar_${id}`).setLabel("✅ Confirmar y enviar al jugador").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`cancelar_${id}`).setLabel("❌ Cancelar").setStyle(ButtonStyle.Danger)
      );

      await interaction.reply({ embeds: [embed], components: [row] });
      return;
    }

    // ── Botón: Squad Leader confirma → DM al jugador ─────────────
    if (interaction.isButton() && interaction.customId.startsWith("confirmar_")) {
      const id = interaction.customId.replace("confirmar_", "");
      const dt = pendientes.get(id);

      if (!dt) {
        await interaction.reply({ content: "⚠️ Esta transferencia ya expiró o no existe.", flags: MessageFlags.Ephemeral });
        return;
      }

      // Detectar equipo origen ahora (antes de enviar DM)
      let equipoOrigenDetectado = "Agente Libre";
      try {
        const member = await interaction.guild.members.fetch(dt.targetUserId);
        const rolActual = member.roles.cache.find(
          (r) => r.name !== "@everyone" && !esRolSistema(r.name) && esRolSeleccion(r.name)
        );
        if (rolActual) equipoOrigenDetectado = rolActual.name;
      } catch { /* se usará "Agente Libre" */ }

      // Guardar datos en pendientesAceptacion (el jugador aún no aceptó)
      pendientes.delete(id);
      pendientesAceptacion.set(id, {
        ...dt,
        equipoOrigen: equipoOrigenDetectado,
        esperandoMsgId: interaction.message.id,
      });

      // Enviar DM al jugador con botón de aceptar/rechazar
      let dmEnviado = false;
      try {
        const targetUser = await client.users.fetch(dt.targetUserId);

        const dmEmbed = new EmbedBuilder()
          .setColor(0xffa500)
          .setDescription(
            buildTransferDescription({
              jugador: `<@${dt.targetUserId}>`,
              pais: dt.pais,
              rated: dt.rated,
              equipoOrigen: equipoOrigenDetectado,
              equipoDestino: dt.equipoDestino,
              confirmado: false,
              extra: `*Propuesto por ${dt.confirmedBy}*`,
            })
          )
          .setTimestamp();

        const dmRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`aceptar_transfer_${id}`).setLabel("✅ Aceptar transferencia").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`rechazar_transfer_${id}`).setLabel("❌ Rechazar").setStyle(ButtonStyle.Danger)
        );

        await targetUser.send({ embeds: [dmEmbed], components: [dmRow] });
        dmEnviado = true;
      } catch (dmErr) {
        console.error("No se pudo enviar DM al jugador:", dmErr.message);
      }

      // Actualizar el embed en el canal
      const FRASES_RUMOR = [
        "El vestuario ya estaría ilusionado con su posible llegada.",
        "Se habla de cifras millonarias en la operación.",
        "Los agentes confirman conversaciones muy avanzadas.",
        "Fuentes del club aseguran que el acuerdo está muy cerca.",
        "El jugador habría pedido el dorsal que siempre quiso.",
        "La directiva lleva semanas trabajando en silencio por este fichaje.",
        "Se espera un anuncio oficial en las próximas horas.",
        "El técnico habría dado el visto bueno personalmente.",
        "Sería el fichaje más sonado de la temporada.",
        "Las negociaciones se aceleran y todo apunta al sí.",
      ];
      const fraseAleatoria = FRASES_RUMOR[Math.floor(Math.random() * FRASES_RUMOR.length)];

      const SEP_R  = "━━━━━━━━━━━━━━━━━━━━";
      const SEP_R2 = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
      const rumorDesc = dmEnviado
        ? [
            `:VirtualStreetSoccer: **RUMOR DE FICHAJE** :VirtualStreetSoccer:`,
            "",
            SEP_R,
            "",
            `📰 Según fuentes exclusivas, **${dt.equipoDestino}** habría presentado`,
            `una oferta formal por <@${dt.targetUserId}>.`,
            "",
            dt.rated ? `**Rated**: ${dt.rated}` : "",
            dt.pais  ? `**País**: ${dt.pais}` : "",
            "",
            SEP_R2,
            "",
            `*${fraseAleatoria}*`,
            "",
            `⏳ *El jugador está valorando la propuesta...*`,
          ].filter(l => l !== undefined).join("\n")
        : `⚠️ No se pudo enviar el DM a <@${dt.targetUserId}> (tiene los mensajes privados desactivados).`;

      const embedCanal = new EmbedBuilder()
        .setColor(0xffa500)
        .setDescription(rumorDesc)
        .setTimestamp();

      await interaction.update({ embeds: [embedCanal], components: [] });
      return;
    }

    // ── Botón: Jugador acepta la transferencia (desde DM) ─────────
    if (interaction.isButton() && interaction.customId.startsWith("aceptar_transfer_")) {
      const id = interaction.customId.replace("aceptar_transfer_", "");
      const dt = pendientesAceptacion.get(id);

      if (!dt) {
        await interaction.reply({ content: "⚠️ Esta propuesta ya fue respondida o expiró.", flags: MessageFlags.Ephemeral });
        return;
      }

      // Solo el jugador al que va dirigida puede aceptar
      if (interaction.user.id !== dt.targetUserId) {
        await interaction.reply({ content: "❌ Esta propuesta no está dirigida a ti.", flags: MessageFlags.Ephemeral });
        return;
      }

      const ahora = new Date();
      const fecha = ahora.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

      let rolesMsg = "";

      // Gestionar roles en el servidor
      try {
        const guild = await client.guilds.fetch(dt.guildId);
        const member = await guild.members.fetch(dt.targetUserId);
        const allRoles = [...guild.roles.cache.values()];

        const rolActual = member.roles.cache.find(
          (r) => r.name !== "@everyone" && !esRolSistema(r.name) && esRolSeleccion(r.name)
        );
        const rolDestinoRaw = findRoleFuzzy(allRoles, dt.equipoDestino);
        const rolDestinoEsAdmin = rolDestinoRaw?.permissions.has(PermissionFlagsBits.Administrator);
        const rolDestino = rolDestinoEsAdmin ? null : rolDestinoRaw;

        if (rolActual) await member.roles.remove(rolActual).catch(() => {});
        if (rolDestino) await member.roles.add(rolDestino).catch(() => {});

        const notas = [];
        const advertencias = [];
        if (rolActual) notas.push(`🔴 Rol quitado: **${rolActual.name}**`);
        if (rolDestinoEsAdmin) advertencias.push(`🚫 El rol **${rolDestinoRaw.name}** tiene permisos de administrador y no puede asignarse`);
        else if (rolDestino) notas.push(`🟢 Rol asignado: **${rolDestino.name}**`);
        else advertencias.push(`⚠️ No se encontró el rol **${dt.equipoDestino}** en el servidor`);

        rolesMsg = (notas.length ? "\n\n" + notas.join("\n") : "") +
                   (advertencias.length ? "\n" + advertencias.join("\n") : "");
      } catch (err) {
        console.error("Error al gestionar roles:", err.message);
        rolesMsg = "\n\n⚠️ No se pudieron cambiar los roles (verifica los permisos del bot)";
      }

      // Guardar en JSON
      const registro = {
        jugador: dt.jugador,
        equipoOrigen: dt.equipoOrigen,
        equipoDestino: dt.equipoDestino,
        rated: dt.rated,
        pais: dt.pais,
        fecha,
        realizadoPor: dt.confirmedBy,
      };
      const datos = cargarDatos();
      datos.transferencias.push(registro);
      guardarDatos(datos);
      pendientesAceptacion.delete(id);

      // Actualizar DM con ficha definitiva
      const dmEmbedFinal = new EmbedBuilder()
        .setColor(0x57f287)
        .setDescription(
          buildTransferDescription({
            jugador: `<@${dt.targetUserId}>`,
            pais: dt.pais,
            rated: dt.rated,
            equipoOrigen: dt.equipoOrigen,
            equipoDestino: dt.equipoDestino,
            confirmado: true,
            extra: `📅 **Fecha:** ${fecha} | 👤 **${dt.confirmedBy}**`,
          })
        )
        .setTimestamp();

      await interaction.update({ embeds: [dmEmbedFinal], components: [] });

      // Eliminar el mensaje "esperando respuesta" y publicar ficha definitiva
      try {
        const guild = await client.guilds.fetch(dt.guildId);
        const canal = await guild.channels.fetch(dt.channelId);
        if (canal) {
          // Borrar el mensaje de espera
          if (dt.esperandoMsgId) {
            await canal.messages.delete(dt.esperandoMsgId).catch(() => {});
          }
          const canalEmbed = new EmbedBuilder()
            .setColor(0x57f287)
            .setDescription(
              buildTransferDescription({
                jugador: `<@${dt.targetUserId}>`,
                pais: dt.pais,
                rated: dt.rated,
                equipoOrigen: dt.equipoOrigen,
                equipoDestino: dt.equipoDestino,
                confirmado: true,
                extra: `📅 **Fecha:** ${fecha} | 👤 **${dt.confirmedBy}**${rolesMsg}`,
              })
            )
            .setTimestamp();
          await canal.send({ embeds: [canalEmbed] });
        }
      } catch (err) {
        console.error("Error al publicar en canal:", err.message);
      }

      return;
    }

    // ── Botón: Jugador rechaza la transferencia (desde DM) ────────
    if (interaction.isButton() && interaction.customId.startsWith("rechazar_transfer_")) {
      const id = interaction.customId.replace("rechazar_transfer_", "");
      const dt = pendientesAceptacion.get(id);

      if (!dt) {
        await interaction.reply({ content: "⚠️ Esta propuesta ya fue respondida o expiró.", flags: MessageFlags.Ephemeral });
        return;
      }

      if (interaction.user.id !== dt.targetUserId) {
        await interaction.reply({ content: "❌ Esta propuesta no está dirigida a ti.", flags: MessageFlags.Ephemeral });
        return;
      }

      pendientesAceptacion.delete(id);

      // Actualizar DM
      const dmEmbedRechazado = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle("❌ Transferencia Rechazada")
        .setDescription("Rechazaste la propuesta de transferencia. No se realizaron cambios en tus roles.")
        .setTimestamp();

      await interaction.update({ embeds: [dmEmbedRechazado], components: [] });

      // Eliminar mensaje de espera y notificar al canal
      try {
        const guild = await client.guilds.fetch(dt.guildId);
        const canal = await guild.channels.fetch(dt.channelId);
        if (canal) {
          if (dt.esperandoMsgId) {
            await canal.messages.delete(dt.esperandoMsgId).catch(() => {});
          }
          await canal.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0xed4245)
                .setTitle("❌ Transferencia Rechazada")
                .setDescription(`<@${dt.targetUserId}> rechazó la propuesta de transferencia a **${dt.equipoDestino}**.`)
                .setTimestamp(),
            ],
          });
        }
      } catch (err) {
        console.error("Error al notificar rechazo en canal:", err.message);
      }

      return;
    }

    // ── Botón: Squad Leader cancela antes del DM ─────────────────
    if (interaction.isButton() && interaction.customId.startsWith("cancelar_")) {
      const id = interaction.customId.replace("cancelar_", "");
      pendientes.delete(id);

      const embed = new EmbedBuilder()
        .setTitle("❌ Transferencia Cancelada")
        .setColor(0xed4245)
        .setDescription("La transferencia fue cancelada y no se registró.")
        .setTimestamp();

      await interaction.update({ embeds: [embed], components: [] });
      return;
    }

  } catch (err) {
    console.error("Error en interacción:", err.message);
    try {
      const msg = { content: "⚠️ Ocurrió un error inesperado. Inténtalo de nuevo.", flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(msg);
      } else if (!interaction.isModalSubmit()) {
        await interaction.reply(msg);
      }
    } catch { /* silenciar errores secundarios */ }
  }
});

// ── Nunca apagar: capturar errores globales ───────────────────────
process.on("uncaughtException", (err) => {
  console.error("⚠️ uncaughtException (el bot sigue corriendo):", err.message);
});

process.on("unhandledRejection", (reason) => {
  console.error("⚠️ unhandledRejection (el bot sigue corriendo):", reason?.message ?? reason);
});

// Mantener el event loop activo
setInterval(() => {}, 10_000);

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error("❌ No se encontró DISCORD_BOT_TOKEN.");
  process.exit(1);
}

// Eventos de conexión de Discord
client.on("shardDisconnect", (_, id) => {
  console.warn(`⚠️ Shard ${id} desconectado. Discord.js intentará reconectar automáticamente.`);
});
client.on("shardReconnecting", (id) => {
  console.log(`🔄 Shard ${id} reconectando...`);
});
client.on("shardResume", (id) => {
  console.log(`✅ Shard ${id} reconectado.`);
});

// Watchdog: si el bot no está listo, forzar reconexión cada 30 s
let reconectando = false;
setInterval(async () => {
  if (!client.isReady() && !reconectando) {
    reconectando = true;
    console.warn("⚠️ Bot no disponible, intentando reconectar...");
    try {
      await client.login(token);
      console.log("✅ Reconexión exitosa.");
    } catch (err) {
      console.error("❌ Error al reconectar:", err.message);
    } finally {
      reconectando = false;
    }
  }
}, 30_000);

client.login(token);
