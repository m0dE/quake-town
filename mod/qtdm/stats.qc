/*
	stats.qc

	Match statistics (qt_setstat), frags bookkeeping and the qt_obituary event.

	Copyright (C) 2026 Quake Town contributors

	This program is free software; you can redistribute it and/or
	modify it under the terms of the GNU General Public License
	as published by the Free Software Foundation; either version 2
	of the License, or (at your option) any later version.

	This program is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
*/

float(entity p, float id) Stat_Get =
{
	if (id < 12)
	{
		if (id == ST_KILLS) return p.st_kills;
		if (id == ST_DEATHS) return p.st_deaths;
		if (id == ST_SUICIDES) return p.st_suicides;
		if (id == ST_TEAMKILLS) return p.st_teamkills;
		if (id == ST_DMG_GIVEN) return p.st_dmg_given;
		if (id == ST_DMG_TAKEN) return p.st_dmg_taken;
		if (id == ST_RA) return p.st_ra;
		if (id == ST_YA) return p.st_ya;
		if (id == ST_GA) return p.st_ga;
		if (id == ST_MH) return p.st_mh;
		if (id == ST_QUAD) return p.st_quad;
		return p.st_pent;
	}
	if (id == ST_RING) return p.st_ring;
	if (id == ST_RL_SHOTS) return p.st_rl_shots;
	if (id == ST_RL_HITS) return p.st_rl_hits;
	if (id == ST_LG_SHOTS) return p.st_lg_shots;
	if (id == ST_LG_HITS) return p.st_lg_hits;
	if (id == ST_SG_SHOTS) return p.st_sg_shots;
	if (id == ST_SG_HITS) return p.st_sg_hits;
	if (id == ST_SSG_SHOTS) return p.st_ssg_shots;
	if (id == ST_SSG_HITS) return p.st_ssg_hits;
	if (id == ST_GL_SHOTS) return p.st_gl_shots;
	if (id == ST_GL_HITS) return p.st_gl_hits;
	return p.st_eff;
};

void(entity p, float id, float v) Stat_Put =
{
	if (id < 12)
	{
		if (id == ST_KILLS) p.st_kills = v;
		else if (id == ST_DEATHS) p.st_deaths = v;
		else if (id == ST_SUICIDES) p.st_suicides = v;
		else if (id == ST_TEAMKILLS) p.st_teamkills = v;
		else if (id == ST_DMG_GIVEN) p.st_dmg_given = v;
		else if (id == ST_DMG_TAKEN) p.st_dmg_taken = v;
		else if (id == ST_RA) p.st_ra = v;
		else if (id == ST_YA) p.st_ya = v;
		else if (id == ST_GA) p.st_ga = v;
		else if (id == ST_MH) p.st_mh = v;
		else if (id == ST_QUAD) p.st_quad = v;
		else p.st_pent = v;
	}
	else if (id == ST_RING) p.st_ring = v;
	else if (id == ST_RL_SHOTS) p.st_rl_shots = v;
	else if (id == ST_RL_HITS) p.st_rl_hits = v;
	else if (id == ST_LG_SHOTS) p.st_lg_shots = v;
	else if (id == ST_LG_HITS) p.st_lg_hits = v;
	else if (id == ST_SG_SHOTS) p.st_sg_shots = v;
	else if (id == ST_SG_HITS) p.st_sg_hits = v;
	else if (id == ST_SSG_SHOTS) p.st_ssg_shots = v;
	else if (id == ST_SSG_HITS) p.st_ssg_hits = v;
	else if (id == ST_GL_SHOTS) p.st_gl_shots = v;
	else if (id == ST_GL_HITS) p.st_gl_hits = v;
	else if (id == ST_EFFICIENCY) p.st_eff = v;
	else
		return;
	qt_setstat (p, id, v);
};

// efficiency = kills / (kills + deaths), in percent
void(entity p) Stat_UpdateEff =
{
	local float e;

	e = 0;
	if (p.st_kills + p.st_deaths > 0)
		e = rint (p.st_kills * 100 / (p.st_kills + p.st_deaths));
	if (e != p.st_eff)
		Stat_Put (p, ST_EFFICIENCY, e);
};

void(entity p, float id, float n) Stat_Add =
{
	if (!n)
		return;
	if (p.classname != "player" || !p.qt_connected)
		return;
	Stat_Put (p, id, Stat_Get (p, id) + n);
	if (id == ST_KILLS || id == ST_DEATHS)
		Stat_UpdateEff (p);
};

void(entity p) Stat_ResetPlayer =
{
	local float i;

	i = 0;
	while (i < ST_COUNT)
	{
		Stat_Put (p, i, 0);
		i = i + 1;
	}
};

/*
============
AddFrags

Every frag change goes through here so team scores follow.
============
*/
void(entity p, float n) AddFrags =
{
	if (p.classname != "player")
		return;
	p.frags = p.frags + n;
	if (qt_mode == MODE_2ON2 || qt_mode == MODE_4ON4)
	{
		if (p.qteam == TEAM_RED)
			team1score = team1score + n;
		else if (p.qteam == TEAM_BLUE)
			team2score = team2score + n;
		state_dirty = TRUE;
	}
	else if (qt_mode == MODE_DUEL)
		state_dirty = TRUE;
};

/*
============
QT_DeathType

Maps id's deathtype strings / the attacker's weapon to DESIGN.md ids.
============
*/
float(entity targ, entity attacker) QT_DeathType =
{
	local float w;

	if (targ.deathtype == "nail")
		return DT_NAILGUN;
	if (targ.deathtype == "supernail")
		return DT_SNAILGUN;
	if (targ.deathtype == "grenade")
		return DT_GRENADE;
	if (targ.deathtype == "rocket")
		return DT_ROCKET;
	if (targ.deathtype == "discharge" || targ.deathtype == "selfwater")
		return DT_DISCHARGE;
	w = attacker.weapon;
	if (w == IT_AXE)
		return DT_AXE;
	if (w == IT_SHOTGUN)
		return DT_SHOTGUN;
	if (w == IT_SUPER_SHOTGUN)
		return DT_SSHOTGUN;
	if (w == IT_LIGHTNING)
		return DT_LIGHTNING;
	if (w == IT_NAILGUN)
		return DT_NAILGUN;
	if (w == IT_SUPER_NAILGUN)
		return DT_SNAILGUN;
	if (w == IT_GRENADE_LAUNCHER)
		return DT_GRENADE;
	if (w == IT_ROCKET_LAUNCHER)
		return DT_ROCKET;
	return DT_WORLD;
};

/*
============
QT_Obituary

Called on every player death (Killed, ClientKill) before id's ClientObituary
prints and scores it: emits qt_obituary, counts stats, CTF bonuses.
============
*/
void(entity targ, entity attacker) QT_Obituary =
{
	local entity killer;
	local float dt, fl;

	if (targ.classname != "player")
		return;

	killer = world;
	dt = DT_WORLD;
	fl = 0;

	if (attacker.classname == "teledeath" || attacker.classname == "teledeath3")
	{
		killer = attacker.owner;
		dt = DT_TELEFRAG;
		fl = QT_OBF_TELEFRAG;
	}
	else if (attacker.classname == "teledeath2")
	{       // a pentagram deflected the telefrag back on its maker
		killer = targ;
		dt = DT_TELEFRAG;
		fl = QT_OBF_TELEFRAG;
	}
	else if (targ.deathtype == "squish")
	{
		dt = DT_SQUISH;
		if (attacker.classname == "player")
			killer = attacker;
	}
	else if (targ.deathtype == "suicide")
	{
		dt = DT_SUICIDE;
		killer = targ;
	}
	else if (attacker.classname == "player")
	{
		killer = attacker;
		dt = QT_DeathType (targ, attacker);
	}
	else
	{       // the world: same order as id's obituary
		if (targ.watertype == CONTENT_WATER)
			dt = DT_WATER;
		else if (targ.watertype == CONTENT_SLIME)
			dt = DT_SLIME;
		else if (targ.watertype == CONTENT_LAVA)
			dt = DT_LAVA;
		else if (targ.deathtype == "falling")
			dt = DT_FALL;
	}

	if (killer.classname == "player" && killer != targ && SameTeam (killer, targ))
	{
		fl = fl | QT_OBF_TEAMKILL;
		if (dt == DT_WORLD)
			dt = DT_TEAMKILL_OTHER;
	}

	Stat_Add (targ, ST_DEATHS, 1);
	if (killer == targ || killer == world)
		Stat_Add (targ, ST_SUICIDES, 1);
	else if (fl & QT_OBF_TEAMKILL)
		Stat_Add (killer, ST_TEAMKILLS, 1);
	else
	{
		Stat_Add (killer, ST_KILLS, 1);
		if (qt_mode == MODE_CTF)
			CTF_FragBonuses (targ, killer);
	}

	qt_obituary (targ, killer, dt, fl);
};
