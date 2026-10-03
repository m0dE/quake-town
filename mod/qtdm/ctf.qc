/*
	ctf.qc

	ThreeWave-style Capture The Flag: item_flag_team1 (red) and
	item_flag_team2 (blue), info_player_team1/2 spawns, carriers, captures,
	returns, assists and defence bonuses, dropped flags return after 30 s.

	Our own code; the rules and bonus values follow Dave 'Zoid' Kirsch's
	ThreeWave CTF as players know it.

	Copyright (C) 2026 Quake Town contributors

	This program is free software; you can redistribute it and/or
	modify it under the terms of the GNU General Public License
	as published by the Free Software Foundation; either version 2
	of the License, or (at your option) any later version.

	This program is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
*/

string(float t) TeamTitle;
void(string s) CenterAll;

float   CTF_CAPTURE_BONUS       = 15;   // the capturer
float   CTF_TEAM_BONUS          = 10;   // every teammate on a capture
float   CTF_RECOVERY_BONUS      = 1;    // returning your flag
float   CTF_FRAG_CARRIER_BONUS  = 2;    // fragging the enemy carrier
float   CTF_FLAG_DEFENSE_BONUS  = 1;    // fragging an enemy near your flag
float   CTF_CARRIER_PROTECT_BONUS = 1;  // fragging an enemy near your carrier
float   CTF_RETURN_ASSIST_BONUS = 1;    // returned the flag shortly before a capture
float   CTF_FRAG_CARRIER_ASSIST_BONUS = 2;  // fragged the carrier shortly before a capture
float   CTF_ASSIST_TIME         = 4;
float   CTF_DEFENSE_RADIUS      = 400;
float   CTF_FLAG_RETURN_TIME    = 30;

void() info_player_team1 = {};
void() info_player_team2 = {};

// key icon on the status bar while carrying: red flag key1, blue flag key2
float(entity f) CTF_FlagItem =
{
	if (f.flagteam == TEAM_RED)
		return IT_KEY1;
	return IT_KEY2;
};

float(entity f) CTF_FlagEffect =
{
	if (f.flagteam == TEAM_RED)
		return EF_FLAG1;
	return EF_FLAG2;
};

// the flag standing or lying in the world
void(entity f) CTF_FlagLook =
{
	setmodel (f, QT_FLAG_MODEL);
	setsize (f, '-16 -16 0', '16 16 74');
	if (QT_FLAG_REAL)
	{
		f.skin = f.flagteam - 1;
		f.effects = 0;
	}
	else
	{       // stand-in model: the team's glow tells the flags apart
		f.skin = 0;
		if (f.flagteam == TEAM_RED)
			f.effects = EF_RED;
		else
			f.effects = EF_BLUE;
	}
};

void(entity p) CTF_StripCarrier =
{
	local entity f;

	f = p.carriedflag;
	if (!f)
		return;
	p.carriedflag = world;
	p.items = p.items - (p.items & (IT_KEY1 | IT_KEY2));
	p.effects = p.effects - (p.effects & (EF_FLAG1 | EF_FLAG2));
	f.flagcarrier = world;
};

void(entity f) CTF_ReturnFlag =
{
	if (f.flagcarrier)
		CTF_StripCarrier (f.flagcarrier);
	f.flagstate = FLAG_AT_BASE;
	f.flagcarrier = world;
	CTF_FlagLook (f);
	f.solid = SOLID_TRIGGER;
	f.movetype = MOVETYPE_TOSS;
	f.flags = FL_ITEM;
	f.velocity = '0 0 0';
	f.angles = f.mangle;
	setorigin (f, f.flaghome);
	f.think = SUB_Null;
	f.nextthink = 0;
};

void() CTF_ResetFlags =
{
	local entity p;

	p = find (world, classname, "player");
	while (p)
	{
		CTF_StripCarrier (p);
		p = find (p, classname, "player");
	}
	if (flag_red)
		CTF_ReturnFlag (flag_red);
	if (flag_blue)
		CTF_ReturnFlag (flag_blue);
};

void() CTF_FlagPlace =
{
	self.origin_z = self.origin_z + 6;
	if (!droptofloor ())
	{
		dprint ("flag fell out of level at ");
		dprint (vtos (self.origin));
		dprint ("\n");
		self.origin_z = self.origin_z - 6;
	}
	self.flaghome = self.origin;
	self.flagstate = FLAG_AT_BASE;
};

// dropped: home after 30 s, or at once in lava / slime / sky
void() CTF_FlagThink =
{
	local float c;

	if (self.flagstate != FLAG_DROPPED)
		return;
	c = pointcontents (self.origin);
	if (time >= self.flag_returntime || c == CONTENT_LAVA || c == CONTENT_SLIME || c == CONTENT_SKY)
	{
		bprint (PRINT_HIGH, "The ");
		bprint (PRINT_HIGH, self.netname);
		bprint (PRINT_HIGH, " has returned to base\n");
		sound (self, CHAN_ITEM, "items/itembk2.wav", 1, ATTN_NONE);
		CTF_ReturnFlag (self);
		return;
	}
	self.nextthink = time + 0.5;
};

void(entity p, entity own) CTF_Capture =
{
	local entity f, q;

	f = p.carriedflag;
	if (p.qteam == TEAM_RED)
		team1caps = team1caps + 1;
	else
		team2caps = team2caps + 1;

	bprint (PRINT_HIGH, p.netname);
	bprint (PRINT_HIGH, " captured the ");
	bprint (PRINT_HIGH, f.netname);
	bprint (PRINT_HIGH, "!\n");
	if (p.qteam == TEAM_RED)
		CenterAll ("RED team captured the flag!");
	else
		CenterAll ("BLUE team captured the flag!");
	sound (p, CHAN_AUTO, "misc/runekey.wav", 1, ATTN_NONE);

	AddFrags (p, CTF_CAPTURE_BONUS);
	q = find (world, classname, "player");
	while (q)
	{
		if (q.qt_connected && q != p && q.qteam == p.qteam)
		{
			AddFrags (q, CTF_TEAM_BONUS);
			if (q.ctf_lastreturn + CTF_ASSIST_TIME > time)
			{
				bprint (PRINT_MEDIUM, q.netname);
				bprint (PRINT_MEDIUM, " gets an assist for returning the flag!\n");
				AddFrags (q, CTF_RETURN_ASSIST_BONUS);
			}
			if (q.ctf_lastcarrierfrag + CTF_ASSIST_TIME > time)
			{
				bprint (PRINT_MEDIUM, q.netname);
				bprint (PRINT_MEDIUM, " gets an assist for fragging the flag carrier!\n");
				AddFrags (q, CTF_FRAG_CARRIER_ASSIST_BONUS);
			}
		}
		q = find (q, classname, "player");
	}

	CTF_ReturnFlag (f);
	state_dirty = TRUE;
};

void() CTF_FlagTouch =
{
	if (other.classname != "player" || !other.qt_connected || other.health <= 0)
		return;
	if (other.ca_out || !Match_DamageAllowed ())
		return;
	if (self.flagstate == FLAG_CARRIED)
		return;
	if (selftest_step == 10)
		return;         // selftest.qc: waiting for the 30 s auto return
	if (other.qteam != TEAM_RED && other.qteam != TEAM_BLUE)
		return;

	if (other.qteam == self.flagteam)
	{
		if (self.flagstate == FLAG_DROPPED)
		{       // our flag on the ground: back home
			bprint (PRINT_HIGH, other.netname);
			bprint (PRINT_HIGH, " returned the ");
			bprint (PRINT_HIGH, self.netname);
			bprint (PRINT_HIGH, "!\n");
			sound (other, CHAN_ITEM, "doors/runetry.wav", 1, ATTN_NONE);
			AddFrags (other, CTF_RECOVERY_BONUS);
			other.ctf_lastreturn = time;
			CTF_ReturnFlag (self);
			return;
		}
		// our flag at home and the enemy flag in hand: capture
		if (other.carriedflag)
			CTF_Capture (other, self);
		return;
	}

	// the enemy flag: take it
	if (other.carriedflag)
		return;
	other.carriedflag = self;
	self.flagcarrier = other;
	self.flagstate = FLAG_CARRIED;
	self.model = "";        // hidden: the carrier shows it (EF_FLAG1/2)
	self.modelindex = 0;
	self.solid = SOLID_NOT;
	self.movetype = MOVETYPE_NONE;
	self.velocity = '0 0 0';
	self.think = SUB_Null;
	self.nextthink = 0;
	other.items = other.items | CTF_FlagItem (self);
	other.effects = other.effects | CTF_FlagEffect (self);

	bprint (PRINT_HIGH, other.netname);
	bprint (PRINT_HIGH, " got the ");
	bprint (PRINT_HIGH, self.netname);
	bprint (PRINT_HIGH, "!\n");
	centerprint (other, "You got the enemy flag!\n\nReturn to base!");
	sound (other, CHAN_ITEM, "misc/medkey.wav", 1, ATTN_NONE);
};

void(float t) CTF_SpawnFlag =
{
	if (qt_mode != MODE_CTF || (t == TEAM_RED && flag_red) || (t == TEAM_BLUE && flag_blue))
	{
		remove (self);
		return;
	}
	self.flagteam = t;
	if (t == TEAM_RED)
	{
		self.netname = "RED flag";
		flag_red = self;
	}
	else
	{
		self.netname = "BLUE flag";
		flag_blue = self;
	}
	precache_model (QT_FLAG_MODEL);
	CTF_FlagLook (self);
	self.movetype = MOVETYPE_TOSS;
	self.solid = SOLID_TRIGGER;
	self.flags = FL_ITEM;
	self.touch = CTF_FlagTouch;
	self.mangle = self.angles;
	self.flaghome = self.origin;
	self.flagstate = FLAG_AT_BASE;
	self.nextthink = time + 0.2;    // after the world's solids, as items
	self.think = CTF_FlagPlace;
};

/*QUAKED item_flag_team1 (1 0 0) (-16 -16 0) (16 16 74)
The RED team's flag.
*/
void() item_flag_team1 = { CTF_SpawnFlag (TEAM_RED); };

/*QUAKED item_flag_team2 (0 0 1) (-16 -16 0) (16 16 74)
The BLUE team's flag.
*/
void() item_flag_team2 = { CTF_SpawnFlag (TEAM_BLUE); };

// carrier death / kill / disconnect / team change
void(entity p) CTF_DropFlag =
{
	local entity f;

	f = p.carriedflag;
	if (!f)
		return;
	CTF_StripCarrier (p);

	f.flagstate = FLAG_DROPPED;
	CTF_FlagLook (f);
	f.solid = SOLID_TRIGGER;
	f.movetype = MOVETYPE_TOSS;
	f.flags = FL_ITEM;
	setorigin (f, p.origin - '0 0 24');
	f.velocity_z = 300;
	f.velocity_x = -100 + (random() * 200);
	f.velocity_y = -100 + (random() * 200);
	f.flag_returntime = time + CTF_FLAG_RETURN_TIME;
	f.think = CTF_FlagThink;
	f.nextthink = time + 0.5;

	bprint (PRINT_HIGH, p.netname);
	bprint (PRINT_HIGH, " lost the ");
	bprint (PRINT_HIGH, f.netname);
	bprint (PRINT_HIGH, "!\n");
};

void(entity p) CTF_PlayerGone =
{
	CTF_DropFlag (p);
};

// PlayerPostThink of a carrier (self)
void() CTF_CarrierThink =
{
	local entity f;

	f = self.carriedflag;
	self.items = self.items | CTF_FlagItem (f);
	self.effects = self.effects | CTF_FlagEffect (f);
	setorigin (f, self.origin);     // bots and the radar find the flag on its carrier
};

/*
============
CTF_FragBonuses

attacker fragged enemy targ (QT_Obituary, before the flag drops).
============
*/
void(entity targ, entity attacker) CTF_FragBonuses =
{
	local entity own, enemyflag, c;

	if (attacker.qteam == TEAM_RED)
	{
		own = flag_red;
		enemyflag = flag_blue;
	}
	else
	{
		own = flag_blue;
		enemyflag = flag_red;
	}

	if (targ.carriedflag)
	{
		AddFrags (attacker, CTF_FRAG_CARRIER_BONUS);
		attacker.ctf_lastcarrierfrag = time;
		bprint (PRINT_MEDIUM, attacker.netname);
		bprint (PRINT_MEDIUM, " fragged ");
		bprint (PRINT_MEDIUM, TeamTitle (targ.qteam));
		bprint (PRINT_MEDIUM, "'s flag carrier!\n");
		return;
	}

	if (own)
	if (own.flagstate == FLAG_AT_BASE)
	if (vlen (targ.origin - own.origin) < CTF_DEFENSE_RADIUS || vlen (attacker.origin - own.origin) < CTF_DEFENSE_RADIUS)
	{
		AddFrags (attacker, CTF_FLAG_DEFENSE_BONUS);
		bprint (PRINT_MEDIUM, attacker.netname);
		bprint (PRINT_MEDIUM, " defends the ");
		bprint (PRINT_MEDIUM, own.netname);
		bprint (PRINT_MEDIUM, "\n");
		return;
	}

	if (enemyflag)
	if (enemyflag.flagstate == FLAG_CARRIED)
	{
		c = enemyflag.flagcarrier;
		if (c != attacker && c.qt_connected)
		if (vlen (targ.origin - c.origin) < CTF_DEFENSE_RADIUS || vlen (attacker.origin - c.origin) < CTF_DEFENSE_RADIUS)
		{
			AddFrags (attacker, CTF_CARRIER_PROTECT_BONUS);
			bprint (PRINT_MEDIUM, attacker.netname);
			bprint (PRINT_MEDIUM, " defends ");
			bprint (PRINT_MEDIUM, TeamTitle (attacker.qteam));
			bprint (PRINT_MEDIUM, "'s flag carrier\n");
		}
	}
};

/*
============
CTF_AutoFlags

CTF on a map without flags (any DM map): the red and blue flags stand on
the two deathmatch spawn points farthest apart. Called once from the first
StartFrame, after every spawn function ran.
============
*/
void() CTF_AutoFlags =
{
	local entity a, b, besta, bestb, oself;
	local float d, best;

	if (qt_mode != MODE_CTF || flag_red || flag_blue)
		return;
	best = -1;
	besta = bestb = world;
	a = find (world, classname, "info_player_deathmatch");
	while (a)
	{
		b = find (a, classname, "info_player_deathmatch");
		while (b)
		{
			d = vlen (a.origin - b.origin);
			if (d > best)
			{
				best = d;
				besta = a;
				bestb = b;
			}
			b = find (b, classname, "info_player_deathmatch");
		}
		a = find (a, classname, "info_player_deathmatch");
	}
	if (!besta)
	{
		dprint ("CTF: no flags and no spawn points\n");
		return;
	}
	bprint (PRINT_HIGH, "This map has no flags: they stand on the two farthest spawn points\n");
	oself = self;
	self = spawn ();
	self.classname = "item_flag_team1";
	setorigin (self, besta.origin - '0 0 24');
	self.angles = besta.angles;
	CTF_SpawnFlag (TEAM_RED);
	self = spawn ();
	self.classname = "item_flag_team2";
	setorigin (self, bestb.origin - '0 0 24');
	self.angles = bestb.angles;
	CTF_SpawnFlag (TEAM_BLUE);
	self = oself;
	// those two spots become the teams' spawns at their flags
	besta.classname = "info_player_team1";
	bestb.classname = "info_player_team2";
};
