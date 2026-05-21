"use strict"

class RGBA
{
	constructor(r, g, b, a = 1)
	{
		this.r = r;
		this.g = g;
		this.b = b;
		this.a = a;
	}
	setAlpha(a)
	{
		this.a = a;
	}
	toString()
	{
		const hasAlpha = this.a < 1;
		return (hasAlpha ? "rgba(" : "rgb(") 
		+ this.r + ',' + this.g + ',' + this.b
		+ (hasAlpha ? "," + this.a : "")
		+ ")";
	}
}

function clamp(min, max, val)
{
	if (min > max)
		return clamp(max, min, val);
	return Math.min(max, Math.max(min, val));
}

function lerp(a, b, t)
{
	return (1-t)*a + t*b;
}

function inverseLerp(a, b, t)
{
	return (t - a) / (b - a);
}

function map(a, b, y, z, t)
{
	return lerp(y, z, inverseLerp(a, b, t));
}