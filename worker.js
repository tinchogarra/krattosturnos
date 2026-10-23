const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=UTF-8",
};

const SERVICES = [
  "CORTE",
  "SERVICIO DE BARBA",
  "CORTE + BARBA",
];

const APPOINTMENT_MINUTES = 30;

const SHOP_HOURS = {
  1: [["16:30", "20:30"]], // Lunes
  2: [["10:00", "13:00"], ["16:30", "20:30"]], // Martes
  3: [["10:00", "13:00"], ["16:30", "20:30"]], // Miércoles
  4: [["10:00", "13:00"], ["16:30", "20:30"]], // Jueves
  5: [["10:00", "13:00"], ["16:30", "20:30"]], // Viernes
  6: [["10:00", "13:30"], ["17:30", "20:30"]], // Sábado
  0: [], // Domingo
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS,
  });
}

function timeToMinutes(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function minutesToTime(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

function getWeekday(fecha) {
  const date = new Date(`${fecha}T12:00:00Z`);
  return date.getUTCDay();
}

function getAvailableSlots(fecha, appointments) {
  const weekday = getWeekday(fecha);
  const periods = SHOP_HOURS[weekday] || [];
  const slots = [];

  for (const [start, end] of periods) {
    let current = timeToMinutes(start);
    const endMinutes = timeToMinutes(end);

    while (current + APPOINTMENT_MINUTES <= endMinutes) {
      const hora = minutesToTime(current);

      const occupied = appointments.some(
        (appointment) => appointment.hora === hora
      );

      if (!occupied) {
        slots.push(hora);
      }

      current += APPOINTMENT_MINUTES;
    }
  }

  return slots;
}

async function ensureTable(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS turnos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fecha TEXT NOT NULL,
      hora TEXT NOT NULL,
      servicio TEXT NOT NULL,
      nombre TEXT NOT NULL,
      telefono TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    try {
      if (!env.DB) {
        return json(
          {
            error: "La base de datos DB no está vinculada al Worker.",
          },
          500
        );
      }

      await ensureTable(env.DB);

      const url = new URL(request.url);
      const path = url.pathname;

      // GET /api/turnos?fecha=2026-10-23
      if (request.method === "GET" && path === "/api/turnos") {
        const fecha = url.searchParams.get("fecha");

        if (!fecha) {
          return json(
            { error: "Falta el parámetro fecha." },
            400
          );
        }

        const fechaValida = /^\d{4}-\d{2}-\d{2}$/.test(fecha);

        if (!fechaValida) {
          return json(
            { error: "Fecha inválida. Usá YYYY-MM-DD." },
            400
          );
        }

        const result = await env.DB
          .prepare(
            `SELECT id, fecha, hora, servicio, nombre, telefono
             FROM turnos
             WHERE fecha = ?
             ORDER BY hora`
          )
          .bind(fecha)
          .all();

        const appointments = result.results || [];

        const horarios = getAvailableSlots(fecha, appointments);

        return json({
          fecha,
          horarios,
          turnos: appointments,
        });
      }

      // POST /api/turnos
      if (request.method === "POST" && path === "/api/turnos") {
        const body = await request.json();

        const {
          fecha,
          hora,
          servicio,
          nombre,
          telefono = "",
        } = body;

        if (!fecha || !hora || !servicio || !nombre) {
          return json(
            {
              error:
                "Faltan datos. Se requiere fecha, hora, servicio y nombre.",
            },
            400
          );
        }

        if (!SERVICES.includes(servicio)) {
          return json(
            { error: "Servicio inválido." },
            400
          );
        }

        const fechaValida = /^\d{4}-\d{2}-\d{2}$/.test(fecha);

        if (!fechaValida) {
          return json(
            { error: "Fecha inválida. Usá YYYY-MM-DD." },
            400
          );
        }

        const weekday = getWeekday(fecha);
        const periods = SHOP_HOURS[weekday] || [];
        const requestedMinutes = timeToMinutes(hora);

        const validSlot = periods.some(([start, end]) => {
          const startMinutes = timeToMinutes(start);
          const endMinutes = timeToMinutes(end);

          return (
            requestedMinutes >= startMinutes &&
            requestedMinutes + APPOINTMENT_MINUTES <= endMinutes
          );
        });

        if (!validSlot) {
          return json(
            { error: "Ese horario no está disponible." },
            409
          );
        }

        const existing = await env.DB
          .prepare(
            `SELECT id
             FROM turnos
             WHERE fecha = ? AND hora = ?
             LIMIT 1`
          )
          .bind(fecha, hora)
          .first();

        if (existing) {
          return json(
            { error: "Ese turno ya fue reservado." },
            409
          );
        }

        const result = await env.DB
          .prepare(
            `INSERT INTO turnos
             (fecha, hora, servicio, nombre, telefono)
             VALUES (?, ?, ?, ?, ?)`
          )
          .bind(
            fecha,
            hora,
            servicio,
            nombre,
            telefono
          )
          .run();

        return json(
          {
            ok: true,
            message: "Turno reservado correctamente.",
            turno: {
              id: result.meta?.last_row_id,
              fecha,
              hora,
              servicio,
              nombre,
              telefono,
            },
          },
          201
        );
      }

      return json(
        {
          error: "Ruta no encontrada.",
        },
        404
      );
    } catch (error) {
      return json(
        {
          error: "Error interno del Worker.",
          detail: error?.message || String(error),
        },
        500
      );
    }
  },
};
