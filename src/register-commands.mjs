import { REST, Routes, SlashCommandBuilder } from "discord.js";

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) { console.error("❌ No se encontró DISCORD_BOT_TOKEN."); process.exit(1); }

const commands = [
  new SlashCommandBuilder()
    .setName("transferir")
    .setDescription("Realiza la transferencia de un jugador a otro equipo")
    .addUserOption((o) => o.setName("jugador").setDescription("Miembro a transferir").setRequired(true))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("historial")
    .setDescription("Muestra el historial de las últimas transferencias realizadas")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Muestra todos los comandos disponibles del bot")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("released")
    .setDescription("Despide a un jugador del equipo")
    .addUserOption((o) => o.setName("jugador").setDescription("Jugador a despedir").setRequired(true))
    .toJSON(),
];

const rest = new REST({ version: "10" }).setToken(token);

async function registrar() {
  try {
    console.log("⏳ Registrando comandos slash...");
    const appInfo = await rest.get(Routes.oauth2CurrentApplication());
    await rest.put(Routes.applicationCommands(appInfo.id), { body: commands });
    console.log(`✅ Comandos registrados para ${appInfo.id}`);
    commands.forEach((c) => console.log(`  /${c.name} - ${c.description}`));
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
}

registrar();
